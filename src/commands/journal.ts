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

async function getTimezone(userId: number) {
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
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

  return Array.from(new Set(tags));
}

async function upsertDraft(params: {
  userId: number;
  chatId: number;
  tz: string;
  patch?: Record<string, any>;
  awaiting?: Awaiting;
}) {
  const { userId, chatId, tz, patch, awaiting } = params;

  const current = await getDraft(userId);
  const cur = current?.journal || {};

  await Draft.findOneAndUpdate(
    { userId, kind: "journal" },
    {
      $set: {
        userId,
        chatId,
        kind: "journal",
        step: "panel",
        timezone: tz,
        journal: {
          ...cur,
          ...(patch || {}),
          awaiting: awaiting,
        },
        expiresAt: expiresIn(30),
      },
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
  const title = d?.journal?.title ? String(d.journal.title) : "";
  const body = d?.journal?.body ? String(d.journal.body) : "";
  const tags = Array.isArray(d?.journal?.tags) ? d.journal.tags : [];

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
    [Markup.button.callback("Cancel", "jr:cancel")],
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

    const tz = await getTimezone(userId);

    await clearDraft(userId);
    await upsertDraft({
      userId,
      chatId,
      tz,
      patch: { title: "", body: "", tags: [], entities: [] },
      awaiting: undefined,
    });

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

    const tz = await getTimezone(userId);

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
      await upsertDraft({ userId, chatId, tz, awaiting: "title" });
      await ctx.reply("Type a title (or type '-' to clear it).");
      return;
    }

    if (data === "jr:body") {
      await upsertDraft({ userId, chatId, tz, awaiting: "body" });
      await ctx.reply("Send your journal entry body now.");
      return;
    }

    if (data === "jr:tags") {
      await upsertDraft({ userId, chatId, tz, awaiting: "tags" });
      await ctx.reply("Type tags like: #tag-1 #tag-2 (you can include other text too; I’ll extract the #tags).");
      return;
    }

    if (data === "jr:preview") {
      const fresh = await getDraft(userId);

      const title = fresh?.journal?.title ? String(fresh.journal.title) : "";
      const body = fresh?.journal?.body ? String(fresh.journal.body) : "";
      const tags = Array.isArray(fresh?.journal?.tags) ? fresh.journal.tags : [];
      const entities = Array.isArray(fresh?.journal?.entities) ? fresh.journal.entities : undefined;

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

      const title = fresh?.journal?.title ? String(fresh.journal.title) : "";
      const body = fresh?.journal?.body ? String(fresh.journal.body) : "";
      const tags = Array.isArray(fresh?.journal?.tags) ? fresh.journal.tags : [];
      const entities = Array.isArray(fresh?.journal?.entities) ? fresh.journal.entities : undefined;

      if (!body.trim()) {
        await ctx.reply("Body is not set yet. Tap Set body.");
        return;
      }

      await JournalEntry.create({
        userId,
        chatId,
        title: title.trim() || "",
        body,
        tags,
        entities: entities || [],
      });

      await clearDraft(userId);
      await ctx.reply("Saved journal entry.");
      return;
    }
  });

  bot.on("text", async (ctx, next) => {
    const text = ctx.message?.text || "";
    if (text.startsWith("/")) return next();

    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return next();

    if (!isDM(ctx)) return next();

    const tz = await getTimezone(userId);

    const d = await getDraft(userId);
    if (!d) return next();

    const awaiting: Awaiting | undefined = d.journal?.awaiting;
    if (!awaiting) return next();

    const rawEntities = (ctx.message as any)?.entities;
    const entities = Array.isArray(rawEntities) ? rawEntities : undefined;

    if (awaiting === "title") {
      const val = text.trim() === "-" ? "" : text.trim();

      await upsertDraft({
        userId,
        chatId,
        tz,
        patch: { title: val },
        awaiting: undefined,
      });

      const fresh = await getDraft(userId);
      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    if (awaiting === "body") {
      await upsertDraft({
        userId,
        chatId,
        tz,
        patch: { body: text, entities },
        awaiting: undefined,
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
        tz,
        patch: { tags },
        awaiting: undefined,
      });

      const fresh = await getDraft(userId);
      await ctx.reply(panelText(fresh), kbMain());
      return;
    }

    return next();
  });
}