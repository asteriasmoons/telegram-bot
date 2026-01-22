import { Telegraf, Markup } from "telegraf";

import { Draft } from "../models/Draft";
import { JournalEntry } from "../models/JournalEntry";
import { UserSettings } from "../models/UserSettings";

type Awaiting = "title" | "body" | "tags";

function expiresIn(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

function isDM(ctx: any) {
  return ctx.chat?.type === "private";
}

async function getSettings(userId: number) {
  return UserSettings.findOne({ userId }).lean();
}

async function getDraft(userId: number) {
  return (Draft.findOne({ userId, kind: "journal" }).lean() as any) as any;
}

async function clearDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "journal" });
}

function normalizeTagsFromText(input: string): string[] {
  const matches = input.match(/#[A-Za-z0-9_-]+/g) || [];
  const tags = matches
    .map((t) => t.slice(1).trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  // Unique
  return Array.from(new Set(tags));
}

async function upsertDraft(params: {
  userId: number;
  chatId: number;
  patch?: Record<string, any>;
  awaiting?: Awaiting;
}) {
  const { userId, chatId, patch, awaiting } = params;

  const current = await getDraft(userId);
  const curEntry = current?.entry || {};

  await Draft.findOneAndUpdate(
    { userId, kind: "journal" },
    {
      $set: {
        userId,
        chatId,
        kind: "journal",
        step: "panel",
        entry: {
          ...curEntry,
          ...(patch || {}),
          awaiting: awaiting
        },
        expiresAt: expiresIn(30)
      }
    },
    { upsert: true, new: true }
  );
}

function fmtTags(tags: string[] | undefined) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return "(none)";
  return list.map((t) => `#${t}`).join(" ");
}

function panelText(d: any) {
  const title = d?.entry?.title ? String(d.entry.title) : "";
  const body = d?.entry?.body ? String(d.entry.body) : "";
  const tags = Array.isArray(d?.entry?.tags) ? d.entry.tags : [];

  const lines: string[] = [];
  lines.push("New journal entry");
  lines.push("");
  lines.push(`Title: ${title ? title : "(not set)"}`);
  lines.push(`Tags: ${fmtTags(tags)}`);
  lines.push("");
  lines.push("Body:");
  lines.push(body ? body : "(not set)");
  lines.push("");
  lines.push("Use the buttons below to set each part, then Preview or Save.");
  return lines.join("\n");
}

function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Set title", "jr:title")],
    [Markup.button.callback("Set body", "jr:body")],
    [Markup.button.callback("Set tags", "jr:tags")],
    [Markup.button.callback("Preview", "jr:preview"), Markup.button.callback("Save", "jr:save")],
    [Markup.button.callback("Cancel", "jr:cancel")]
  ]);
}

export function registerJournalFlow(bot: Telegraf<any>) {
  bot.command("journal", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) return;

    if (!isDM(ctx)) {
      await ctx.reply("For privacy, journaling works in DM only. Open a DM with me and try /journal.");
      return;
    }

    // If you prefer forcing /start first, you can enforce dmChatId here.
    // For now, we allow DM chatId directly (still DM-only).
    await clearDraft(userId);
    await upsertDraft({ userId, chatId, patch: { title: "", body: "", tags: [], entities: [] } });

    const d = await getDraft(userId);
    await ctx.reply(panelText(d), kbMain());
  });

  bot.action(/^jr:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});

    if (!isDM(ctx)) {
      await ctx.reply("For privacy, journaling works in DM only. Open a DM with me and try /journal.");
      return;
    }

    const data = (ctx.callbackQuery as any)?.data as string;
    const d = await getDraft(userId);

    if (!d) {
      await ctx.reply("No active journal session. Run /journal again.");
      return;
    }

    if (data === "jr:cancel") {
      await clearDraft(userId);
      await ctx.reply("Cancelled.");
      return;
    }

    if (data === "jr:title") {
      await upsertDraft({ userId, chatId, awaiting: "title" });
      await ctx.reply("Type a title (or type '-' to clear it).");
      return;
    }

    if (data === "jr:body") {
      await upsertDraft({ userId, chatId, awaiting: "body" });
      await ctx.reply("Send your journal entry body now.");
      return;
    }

    if (data === "jr:tags") {
      await upsertDraft({ userId, chatId, awaiting: "tags" });
      await ctx.reply("Type tags like: #tag-1 #tag-2 (you can include other text too -- I’ll extract the #tags).");
      return;
    }

    if (data === "jr:preview") {
      const fresh = await getDraft(userId);

      const title = fresh?.entry?.title ? String(fresh.entry.title) : "";
      const body = fresh?.entry?.body ? String(fresh.entry.body) : "";
      const tags = Array.isArray(fresh?.entry?.tags) ? fresh.entry.tags : [];
      const entities = Array.isArray(fresh?.entry?.entities) ? fresh.entry.entities : undefined;

      const previewLines: string[] = [];
      if (title.trim()) previewLines.push(title.trim(), "");
      previewLines.push(body ? body : "(no body set yet)");
      if (tags.length) previewLines.push("", `Tags: ${fmtTags(tags)}`);

      const text = previewLines.join("\n");

      if (entities && entities.length > 0) {
        await ctx.reply(text, { entities, parse_mode: undefined } as any);
      } else {
        await ctx.reply(text);
      }

      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    if (data === "jr:save") {
      const fresh = await getDraft(userId);

      const title = fresh?.entry?.title ? String(fresh.entry.title) : "";
      const body = fresh?.entry?.body ? String(fresh.entry.body) : "";
      const tags = Array.isArray(fresh?.entry?.tags) ? fresh.entry.tags : [];
      const entities = Array.isArray(fresh?.entry?.entities) ? fresh.entry.entities : undefined;

      if (!body.trim()) {
        await ctx.reply("Body is not set yet. Tap Set body.");
        return;
      }

      // Store chatId as the DM chat
      await JournalEntry.create({
        userId,
        chatId,
        title: title.trim() || "",
        body,
        tags,
        entities: entities || []
      });

      await clearDraft(userId);
      await ctx.reply("Saved journal entry.");
      return;
    }

    // Unknown jr action: ignore
  });

  // Typed input handler (only consumes when awaiting is set)
  bot.on("text", async (ctx, next) => {
    const text = ctx.message?.text || "";
    if (text.startsWith("/")) return next();

    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return next();

    if (!isDM(ctx)) return next();

    const d = await getDraft(userId);
    if (!d) return next();

    const awaiting: Awaiting | undefined = d.entry?.awaiting;
    if (!awaiting) return next();
     console.log("[JOURNAL] text handler hit", {
  text,
  awaiting,
  userId,
});

    // Capture entities if present (lets you preserve custom emojis later if you want)
    const rawEntities = (ctx.message as any)?.entities;
    const entities = Array.isArray(rawEntities) ? rawEntities : undefined;

    if (awaiting === "title") {
      const val = text.trim() === "-" ? "" : text.trim();

      await upsertDraft({
        userId,
        chatId,
        patch: { title: val },
        awaiting: undefined
      });

      const fresh = await getDraft(userId);
      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    if (awaiting === "body") {
      await upsertDraft({
        userId,
        chatId,
        patch: { body: text, entities },
        awaiting: undefined
      });

      const fresh = await getDraft(userId);
      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    if (awaiting === "tags") {
      const tags = normalizeTagsFromText(text);

      await upsertDraft({
        userId,
        chatId,
        patch: { tags },
        awaiting: undefined
      });

      const fresh = await getDraft(userId);
      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    return next();
  });
}