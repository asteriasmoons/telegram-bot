import type { Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { DateTime } from "luxon";

import { JournalEntry } from "../models/JournalEntry";
import { Draft } from "../models/Draft";
import { UserSettings } from "../models/UserSettings";

const PAGE_SIZE = 6;

type Awaiting = "title" | "body" | "tags";

function isDM(ctx: any) {
  return ctx.chat?.type === "private";
}

async function getTimezone(userId: number) {
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

function expiresIn(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

function fmtWhen(d: Date | undefined, tz: string) {
  if (!d) return "";
  const dt = DateTime.fromJSDate(d, { zone: tz });
  return dt.isValid ? dt.toFormat("LLL d, yyyy 'at' HH:mm") : "";
}

function fmtTags(tags: string[] | undefined) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return "(none)";
  return list.map((t) => `#${t}`).join(" ");
}

function truncate(s: string, n: number) {
  const clean = String(s || "").trim().replace(/\s+/g, " ");
  if (clean.length <= n) return clean;
  return clean.slice(0, n - 1) + "…";
}

function normalizeTagsFromText(input: string): string[] {
  const matches = input.match(/#[A-Za-z0-9_-]+/g) || [];
  const tags = matches
    .map((t) => t.slice(1).trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  return Array.from(new Set(tags));
}

/** ---------------------------
 * Draft helpers (journal_edit)
 * --------------------------*/

async function clearEditDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "journal_edit" });
}

async function getEditDraft(userId: number) {
  return Draft.findOne({ userId, kind: "journal_edit" }).lean() as any;
}

async function upsertEditDraft(params: {
  userId: number;
  chatId: number;
  tz: string;
  journalId: string;
  page: number;
  awaiting?: Awaiting;
  patch?: Record<string, any>;
}) {
  const { userId, chatId, tz, journalId, page, awaiting, patch } = params;

  const current = await Draft.findOne({ userId, kind: "journal_edit" }).lean() as any;
  const curEdit = current?.journalEdit || {};

  await Draft.findOneAndUpdate(
    { userId, kind: "journal_edit" },
    {
      $set: {
        userId,
        chatId,
        kind: "journal_edit",
        step: "edit",
        timezone: tz,
        targetJournalId: journalId,
        page,
        journalEdit: {
          ...curEdit,
          ...(patch || {}),
          awaiting: awaiting || undefined
        },
        expiresAt: expiresIn(30)
      }
    },
    { upsert: true, new: true }
  );
}

/** ---------------------------
 * UI keyboards
 * --------------------------*/

function kbList(entries: any[], page: number) {
  const rows: any[] = [];

  for (const e of entries) {
    const title = e.title?.trim() ? e.title.trim() : "Untitled";
    const bodyPreview = truncate(e.body, 36);
    const label = `${truncate(title, 28)} -- ${bodyPreview}`;
    rows.push([Markup.button.callback(label, `jrnl:open:${String(e._id)}:${page}`)]);
  }

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("Prev", `jrnl:list:${page - 1}`));
  if (entries.length === PAGE_SIZE) nav.push(Markup.button.callback("Next", `jrnl:list:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("Close", "jrnl:close")]);
  return Markup.inlineKeyboard(rows);
}

function kbOpen(id: string, page: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Edit title", `jrnl:edit:title:${id}:${page}`),
      Markup.button.callback("Edit tags", `jrnl:edit:tags:${id}:${page}`)
    ],
    [Markup.button.callback("Edit body", `jrnl:edit:body:${id}:${page}`)],
    [
      Markup.button.callback("Delete", `jrnl:del:${id}:${page}`),
      Markup.button.callback("Back", `jrnl:list:${page}`)
    ],
    [Markup.button.callback("Close", "jrnl:close")]
  ]);
}

function kbEditPanel(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Save changes", `jrnl:save:${id}:${page}`)],
    [Markup.button.callback("Cancel edit", `jrnl:cancel:${id}:${page}`)]
  ]);
}

/** ---------------------------
 * Render helpers
 * --------------------------*/

function renderEntry(e: any, tz: string) {
  const title = e.title?.trim() ? e.title.trim() : "";
  const body = e.body ? String(e.body) : "";
  const tags = Array.isArray(e.tags) ? e.tags : [];
  const when = fmtWhen(e.createdAt ? new Date(e.createdAt) : undefined, tz);

  const lines: string[] = [];
  lines.push("Journal entry");
  lines.push("");
  if (title) lines.push(title, "");
  lines.push(body || "(empty)");
  lines.push("");
  lines.push(`Tags: ${fmtTags(tags)}`);
  if (when) lines.push(`Saved: ${when}`);
  return lines.join("\n");
}

function renderEditPreview(entry: any, edit: any, tz: string) {
  const title =
    typeof edit?.stagedTitle === "string" ? edit.stagedTitle : (entry.title || "");
  const body =
    typeof edit?.stagedBody === "string" ? edit.stagedBody : (entry.body || "");
  const tags =
    Array.isArray(edit?.stagedTags) ? edit.stagedTags : (Array.isArray(entry.tags) ? entry.tags : []);
  const when = fmtWhen(entry.createdAt ? new Date(entry.createdAt) : undefined, tz);

  const lines: string[] = [];
  lines.push("Editing journal entry");
  lines.push("");
  if (String(title).trim()) lines.push(String(title).trim(), "");
  lines.push(String(body || "(empty)"));
  lines.push("");
  lines.push(`Tags: ${fmtTags(tags)}`);
  if (when) lines.push(`Saved: ${when}`);
  return lines.join("\n");
}

/** ---------------------------
 * Main flow
 * --------------------------*/

export function registerJournalsFlow(bot: Telegraf<any>) {
  bot.command("journals", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    if (!isDM(ctx)) {
      await ctx.reply("For privacy, journals are DM-only. Open a DM with me and try /journals.");
      return;
    }

    await clearEditDraft(userId);

    const tz = await getTimezone(userId);
    const page = 0;

    const entries = await JournalEntry.find({ userId })
      .sort({ createdAt: -1 })
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();

    if (entries.length === 0) {
      await ctx.reply("No journal entries yet. Use /journal to create one.");
      return;
    }

    await ctx.reply(
      `Your journal entries (newest first) -- timezone: ${tz}`,
      kbList(entries, page)
    );
  });

  bot.action(/^jrnl:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const data = (ctx.callbackQuery as any)?.data as string;
    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});

    if (!isDM(ctx)) {
      await ctx.reply("For privacy, journals are DM-only.");
      return;
    }

    const tz = await getTimezone(userId);

    if (data === "jrnl:close") {
      await clearEditDraft(userId);
      await ctx.reply("Closed.");
      return;
    }

    if (data.startsWith("jrnl:list:")) {
      const page = Number(data.split(":")[2] || "0");

      const entries = await JournalEntry.find({ userId })
        .sort({ createdAt: -1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean();

      if (entries.length === 0) {
        await ctx.reply("No entries on that page.");
        return;
      }

      await ctx.reply(
        `Your journal entries (newest first) -- timezone: ${tz}`,
        kbList(entries, page)
      );
      return;
    }

    if (data.startsWith("jrnl:open:")) {
      const [, , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await clearEditDraft(userId);

      const entry = await JournalEntry.findOne({ _id: id, userId }).lean();
      if (!entry) {
        await ctx.reply("That entry no longer exists.");
        return;
      }

      await ctx.reply(renderEntry(entry, tz));
      await ctx.reply("Actions:", kbOpen(String(entry._id), page));
      return;
    }

    if (data.startsWith("jrnl:del:")) {
      const [, , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await clearEditDraft(userId);

      const deleted = await JournalEntry.findOneAndDelete({ _id: id, userId }).lean();
      if (!deleted) {
        await ctx.reply("That entry no longer exists.");
        return;
      }

      const entries = await JournalEntry.find({ userId })
        .sort({ createdAt: -1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean();

      if (entries.length === 0) {
        await ctx.reply("Deleted. No entries left.");
        return;
      }

      await ctx.reply("Deleted. Here are your entries:", kbList(entries, page));
      return;
    }

    if (data.startsWith("jrnl:edit:")) {
      const parts = data.split(":"); // jrnl:edit:<field>:<id>:<page>
      const field = parts[2] as Awaiting; // title|body|tags
      const id = parts[3];
      const page = Number(parts[4] || "0");

      const entry = await JournalEntry.findOne({ _id: id, userId }).lean();
      if (!entry) {
        await ctx.reply("That entry no longer exists.");
        return;
      }

      // seed staged fields from the current entry (so save is safe)
      await upsertEditDraft({
        userId,
        chatId,
        tz,
        journalId: id,
        page,
        awaiting: field,
        patch: {
          stagedTitle: entry.title || "",
          stagedBody: entry.body || "",
          stagedTags: Array.isArray(entry.tags) ? entry.tags : [],
          stagedEntities: Array.isArray(entry.entities) ? entry.entities : []
        }
      });

      if (field === "title") {
        await ctx.reply("Send a new title (or type '-' to clear it).");
      } else if (field === "body") {
        await ctx.reply("Send the new body text now.");
      } else {
        await ctx.reply("Send tags like: #tag-1 #tag-2 (I’ll extract #tags).");
      }
      return;
    }

    if (data.startsWith("jrnl:cancel:")) {
      await clearEditDraft(userId);
      await ctx.reply("Edit cancelled.");
      return;
    }

    if (data.startsWith("jrnl:save:")) {
      const parts = data.split(":"); // jrnl:save:<id>:<page>
      const id = parts[2];
      const page = Number(parts[3] || "0");

      const d = await getEditDraft(userId);
      if (!d || d.targetJournalId !== id) {
        await ctx.reply("No active edit session for that entry. Open it again and tap Edit.");
        return;
      }

      const entry = await JournalEntry.findOne({ _id: id, userId }).lean();
      if (!entry) {
        await clearEditDraft(userId);
        await ctx.reply("That entry no longer exists.");
        return;
      }

      const edit = d.journalEdit || {};
      const title = typeof edit.stagedTitle === "string" ? edit.stagedTitle : entry.title || "";
      const body = typeof edit.stagedBody === "string" ? edit.stagedBody : entry.body || "";
      const tags = Array.isArray(edit.stagedTags) ? edit.stagedTags : (Array.isArray(entry.tags) ? entry.tags : []);
      const entities = Array.isArray(edit.stagedEntities) ? edit.stagedEntities : (Array.isArray(entry.entities) ? entry.entities : []);

      if (!String(body).trim()) {
        await ctx.reply("Body cannot be empty. Edit the body first, or cancel.");
        return;
      }

      await JournalEntry.updateOne(
        { _id: id, userId },
        { $set: { title: String(title).trim(), body: String(body), tags, entities } }
      );

      await clearEditDraft(userId);

      // show the updated entry immediately
      const updated = await JournalEntry.findOne({ _id: id, userId }).lean();
      await ctx.reply("Saved changes.");
      await ctx.reply(renderEntry(updated, tz));
      await ctx.reply("Actions:", kbOpen(String(id), page));
      return;
    }

    // unknown action -> ignore
  });

  // Typed input for edits (only consumes when a journal_edit draft is awaiting)
  bot.on("text", async (ctx, next) => {
    const text = ctx.message?.text || "";
    if (text.startsWith("/")) return next();

    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return next();
    if (!isDM(ctx)) return next();

    const d = await getEditDraft(userId);
    if (!d) return next();

    const tz = await getTimezone(userId);
    const journalId = String(d.targetJournalId || "");
    const page = Number(d.page || 0);
    const awaiting: Awaiting | undefined = d.journalEdit?.awaiting;

    if (!journalId || !awaiting) return next();

    const entry = await JournalEntry.findOne({ _id: journalId, userId }).lean();
    if (!entry) {
      await clearEditDraft(userId);
      await ctx.reply("That entry no longer exists.");
      return;
    }

    // capture entities only for body edits (optional)
    const rawEntities = (ctx.message as any)?.entities;
    const entities = Array.isArray(rawEntities) ? rawEntities : undefined;

    if (awaiting === "title") {
      const val = text.trim() === "-" ? "" : text.trim();

      await upsertEditDraft({
        userId,
        chatId,
        tz,
        journalId,
        page,
        awaiting: undefined,
        patch: { stagedTitle: val }
      });

      const fresh = await getEditDraft(userId);
      await ctx.reply(renderEditPreview(entry, fresh?.journalEdit, tz), kbEditPanel(journalId, page));
      return;
    }

    if (awaiting === "body") {
      await upsertEditDraft({
        userId,
        chatId,
        tz,
        journalId,
        page,
        awaiting: undefined,
        patch: { stagedBody: text, stagedEntities: entities || [] }
      });

      const fresh = await getEditDraft(userId);
      await ctx.reply(renderEditPreview(entry, fresh?.journalEdit, tz), kbEditPanel(journalId, page));
      return;
    }

    if (awaiting === "tags") {
      const tags = normalizeTagsFromText(text);

      await upsertEditDraft({
        userId,
        chatId,
        tz,
        journalId,
        page,
        awaiting: undefined,
        patch: { stagedTags: tags }
      });

      const fresh = await getEditDraft(userId);
      await ctx.reply(renderEditPreview(entry, fresh?.journalEdit, tz), kbEditPanel(journalId, page));
      return;
    }

    return next();
  });
}