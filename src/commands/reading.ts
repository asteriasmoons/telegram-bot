// src/bot/commands/reading.ts
import { Telegraf, Markup } from "telegraf";
import { Book } from "../models/Book";

type BookStatus = "tbr" | "reading" | "finished";

const PAGE_SIZE = 6;

function normStatus(input: any): BookStatus | null {
  const s = String(input || "").toLowerCase().trim();
  if (s === "tbr") return "tbr";
  if (s === "reading" || s === "active") return "reading";
  if (s === "finished" || s === "done") return "finished";
  if (s === "paused") return "paused";
  if (s === "dnf") return "dnf";
  return null;
}

function toIntOrNull(v: any) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 0 ? i : null;
}

function clampSummary(v: any) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.slice(0, 800);
}

function normalizeProgress(
  status: BookStatus,
  totalPages: number | null,
  currentPage: number | null
) {
  // totalPages can exist for any status
  if (totalPages !== null && totalPages <= 0) totalPages = null;

  // currentPage only makes sense for "reading"
  if (status !== "reading") {
    return { totalPages, currentPage: null };
  }

  // status === "reading"
  if (totalPages !== null && currentPage !== null) {
    currentPage = Math.min(Math.max(currentPage, 0), totalPages);
  }

  return { totalPages, currentPage };
}

function bookLabel(b: any) {
  const title = String(b.title || "").trim() || "(Untitled)";
  const author = String(b.author || "").trim();
  return author ? `${title} -- ${author}` : title;
}

function statusLabel(s: BookStatus) {
  if (s === "tbr") return "TBR";
  if (s === "reading") return "Reading";
  return "Finished";
}

function progressLabel(b: any) {
  const tp = b.totalPages ?? null;
  const cp = b.currentPage ?? null;

  if (b.status !== "reading") return "";
  if (tp === null && cp === null) return "Progress: not set";
  if (tp !== null && cp === null) return `Progress: 0/${tp}`;
  if (tp === null && cp !== null) return `Progress: ${cp}`;
  return `Progress: ${cp}/${tp}`;
}

function detailsText(b: any) {
  const lines: string[] = [];
  lines.push(bookLabel(b));
  lines.push(`Status: ${statusLabel(b.status)}`);

  if (b.status === "reading") {
    lines.push(progressLabel(b));
  }

  const sum = String(b.shortSummary || "").trim();
  if (sum) {
    lines.push("");
    lines.push(sum);
  }

  return lines.join("\n");
}

function listKeyboard(args: { status: BookStatus | "all"; page: number; hasPrev: boolean; hasNext: boolean }) {
  const { status, page, hasPrev, hasNext } = args;

  const rows: any[] = [
    [
      Markup.button.callback("TBR", `books:tab:tbr:0`),
      Markup.button.callback("Reading", `books:tab:reading:0`),
      Markup.button.callback("Finished", `books:tab:finished:0`),
      Markup.button.callback("All", `books:tab:all:0`),
    ],
  ];

  const nav: any[] = [];
  if (hasPrev) nav.push(Markup.button.callback("Prev", `books:page:${status}:${page - 1}`));
  if (hasNext) nav.push(Markup.button.callback("Next", `books:page:${status}:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("Add book", `books:add:start`)]);
  return Markup.inlineKeyboard(rows);
}

function pickBookKeyboard(books: any[], action: string, page: number, status: BookStatus | "all") {
  const rows = books.map((b) => [Markup.button.callback(bookLabel(b), `books:${action}:${String(b._id)}:${status}:${page}`)]);
  rows.push([Markup.button.callback("Back to list", `books:tab:${status}:${page}`)]);
  return Markup.inlineKeyboard(rows);
}

type AddField = "title" | "author" | "totalPages" | "currentPage" | "shortSummary";

type BookDraft = {
  title: string;
  author: string;
  status: BookStatus;
  totalPages: number | null;
  currentPage: number | null;
  shortSummary: string;
  awaiting?: AddField | null;
  messageId?: number | null; // the message we keep editing
};

const addDrafts = new Map<number, BookDraft>();

function newDraft(): BookDraft {
  return {
    title: "",
    author: "",
    status: "tbr",
    totalPages: null,
    currentPage: null,
    shortSummary: "",
    awaiting: null,
    messageId: null,
  };
}

function draftSummaryLines(d: BookDraft) {
  const lines: string[] = [];
  lines.push("Add a book");
  lines.push("");
  lines.push(`Title: ${d.title ? d.title : "(not set)"}`);
  lines.push(`Author: ${d.author ? d.author : "(not set)"}`);
  lines.push(`Status: ${statusLabel(d.status)}`);
  lines.push(`Total pages: ${d.totalPages === null ? "(not set)" : String(d.totalPages)}`);
  lines.push(`Current page: ${d.currentPage === null ? "(not set)" : String(d.currentPage)}`);
  lines.push(`Short summary: ${d.shortSummary ? d.shortSummary : "(not set)"}`);

  if (d.awaiting) {
    lines.push("");
    lines.push(`Waiting for: ${d.awaiting}`);
    lines.push("Type your value in chat (not a command).");
  }

  return lines.join("\n");
}

function addBuilderKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Title", "books:add:field:title"), Markup.button.callback("Author", "books:add:field:author")],
    [Markup.button.callback("Status", "books:add:status:menu")],
    [Markup.button.callback("Total pages", "books:add:field:totalPages"), Markup.button.callback("Current page", "books:add:field:currentPage")],
    [Markup.button.callback("Short summary", "books:add:field:shortSummary")],
    [Markup.button.callback("Save", "books:add:save"), Markup.button.callback("Cancel", "books:add:cancel")],
  ]);
}

async function renderAddFlow(ctx: any, userId: number) {
  const draft = addDrafts.get(userId) || newDraft();
  addDrafts.set(userId, draft);

  const text = draftSummaryLines(draft);
  const kb = addBuilderKeyboard();

  // If we have a messageId, try to edit that same message (keeps UI clean)
  if (draft.messageId && ctx.telegram && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, draft.messageId, undefined, text, kb);
      return;
    } catch {
      // fall through to sending a new message
    }
  }

  const sent = await ctx.reply(text, kb);
  draft.messageId = sent?.message_id ?? null;
  // DO NOT clear awaiting here -- user may be in the middle of entering a field
  addDrafts.set(userId, draft);
  return; // optional, but makes intent clear
}

async function startAddFlow(ctx: any) {
  const userId = getUserId(ctx);
  if (!userId) return ctx.reply("Unauthorized.");

  addDrafts.set(userId, newDraft());
  return renderAddFlow(ctx, userId);
}

function promptForField(field: AddField) {
  if (field === "title") return "Send the title:";
  if (field === "author") return "Send the author (or type - to clear):";
  if (field === "totalPages") return "Send total pages (number) or - to clear:";
  if (field === "currentPage") return "Send current page (number) or - to clear:";
  return "Send short summary (up to 800 chars) or - to clear:";
}

// -------------------- PROGRESS PICKER STATE --------------------
type ProgressDraft = {
  bookId: string;
};

const progressDrafts = new Map<number, ProgressDraft>();

function progressPromptText(book: any) {
  const lines: string[] = [];
  lines.push(bookLabel(book));
  lines.push(`Status: ${statusLabel(book.status)}`);
  if (book.status === "reading") lines.push(progressLabel(book));
  lines.push("");
  lines.push("Send:");
  lines.push("<currentPage> [totalPages]");
  lines.push("");
  lines.push("Examples:");
  lines.push("120 640");
  lines.push("85");
  lines.push("");
  lines.push("Type - to cancel.");
  return lines.join("\n");
}

function progressPickKeyboard(books: any[], page: number, hasPrev: boolean, hasNext: boolean) {
  const rows = books.map((b) => [
    Markup.button.callback(bookLabel(b), `books:progress:pick:${String(b._id)}:${page}`),
  ]);

  const nav: any[] = [];
  if (hasPrev) nav.push(Markup.button.callback("Prev", `books:progress:page:${page - 1}`));
  if (hasNext) nav.push(Markup.button.callback("Next", `books:progress:page:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("Back", "books:tab:reading:0")]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Register reading commands + callback handlers
 * Assumes ctx.state.userId is set, or ctx.from.id is your userId.
 */
export function registerReading(bot: Telegraf<any>) {
  // ---------- Slash commands ----------
  bot.command(["books", "reading"], async (ctx) => {
    await showList(ctx, "reading", 0);
  });

  bot.command("tbr", async (ctx) => {
    await showList(ctx, "tbr", 0);
  });

  bot.command("finished", async (ctx) => {
    await showList(ctx, "finished", 0);
  });

  // Add quickly:
  // /bookadd now opens the guided "Add Book" builder (buttons -> then type)
  bot.command("bookadd", async (ctx) => {
    const userId = getUserId(ctx);
    if (!userId) return ctx.reply("Unauthorized.");
    return startAddFlow(ctx);
  });

// Update progress (NO IDs)
// /progress -> pick a book -> type progress
bot.command("progress", async (ctx) => {
  return showProgressPicker(ctx, 0);
});

  // Change status:
  // /status <bookId> tbr|reading|finished
  bot.command("status", async (ctx) => {
    const userId = getUserId(ctx);
    if (!userId) return ctx.reply("Unauthorized.");

    const raw = (ctx.message?.text || "").replace(/^\/status(@\w+)?/i, "").trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return ctx.reply("Usage: /status <bookId> tbr|reading|finished");

    const id = parts[0];
    const status = normStatus(parts[1]);
    if (!status) return ctx.reply("Invalid status. Use tbr, reading, or finished.");

    const current = await Book.findOne({ _id: id, userId }).lean();
    if (!current) return ctx.reply("Book not found.");

    const totalPages = current.totalPages ?? null;
    const currentPage = current.currentPage ?? null;
    const prog = normalizeProgress(status, totalPages, currentPage);

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      { $set: { status, totalPages: prog.totalPages, currentPage: prog.currentPage } },
      { new: true }
    ).lean();

    return ctx.reply(detailsText(updated));
  });

  // Delete:
  // /bookdel <bookId>
  bot.command("bookdel", async (ctx) => {
    const userId = getUserId(ctx);
    if (!userId) return ctx.reply("Unauthorized.");

    const raw = (ctx.message?.text || "").replace(/^\/bookdel(@\w+)?/i, "").trim();
    const id = raw.split(/\s+/)[0];

    if (!id) return ctx.reply("Usage: /bookdel <bookId>");

    const deleted = await Book.findOneAndDelete({ _id: id, userId }).lean();
    if (!deleted) return ctx.reply("Book not found.");

    return ctx.reply("Deleted.");
  });
  
    // Capture typed replies for the Add Book draft (only when awaiting a field)
bot.on("text", async (ctx, next) => {
  const userId = getUserId(ctx);
  if (!userId) return next();

  const text = String((ctx.message as any)?.text || "").trim();
  if (!text) return next();
  if (text.startsWith("/")) return next();

  // 1) PRIORITY: Add-book draft input
  const draft = addDrafts.get(userId);
  if (draft?.awaiting) {
    const field = draft.awaiting;
    const clear = text === "-";

    if (field === "title") draft.title = clear ? "" : text;
    if (field === "author") draft.author = clear ? "" : text;
    if (field === "shortSummary") draft.shortSummary = clear ? "" : clampSummary(text);

    if (field === "totalPages") {
      if (clear) draft.totalPages = null;
      else {
        const n = toIntOrNull(text);
        if (n === null) return ctx.reply("Total pages must be a non-negative number (or - to clear).");
        draft.totalPages = n;
      }
    }

    if (field === "currentPage") {
      if (clear) draft.currentPage = null;
      else {
        const n = toIntOrNull(text);
        if (n === null) return ctx.reply("Current page must be a non-negative number (or - to clear).");
        draft.currentPage = n;
      }
    }

    const prog = normalizeProgress(draft.status, draft.totalPages, draft.currentPage);
    draft.totalPages = prog.totalPages;
    draft.currentPage = prog.currentPage;

    draft.awaiting = null;
    addDrafts.set(userId, draft);

    await renderAddFlow(ctx, userId);
    return;
  }

  // 2) SECOND PRIORITY: Progress update input
  const pd = progressDrafts.get(userId);
  if (pd) {
    if (text === "-") {
      progressDrafts.delete(userId);
      await ctx.reply("Progress update cancelled.");
      return;
    }

    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 2) {
      await ctx.reply("Format must be: <currentPage> [totalPages]  (example: 120 640)");
      return;
    }

    const currentPage = toIntOrNull(parts[0]);
    const totalPages = parts.length === 2 ? toIntOrNull(parts[1]) : null;

    if (currentPage === null) return ctx.reply("Current page must be a non-negative number.");
    if (parts.length === 2 && totalPages === null) return ctx.reply("Total pages must be a non-negative number.");

    const book = await Book.findOne({ _id: pd.bookId, userId }).lean();
    if (!book) {
      progressDrafts.delete(userId);
      return ctx.reply("Book not found anymore.");
    }

    if (book.status !== "reading") {
      progressDrafts.delete(userId);
      return ctx.reply("That book is no longer marked as Reading.");
    }

    const tp = totalPages !== null ? totalPages : (book.totalPages ?? null);
    const prog = normalizeProgress("reading", tp, currentPage);

    const updated = await Book.findOneAndUpdate(
      { _id: pd.bookId, userId },
      { $set: { totalPages: prog.totalPages, currentPage: prog.currentPage } },
      { new: true }
    ).lean();

    progressDrafts.delete(userId);
    await ctx.reply(detailsText(updated));
    return;
  }

  return next();
});

  // ---------- Callback handlers (UI-like flow) ----------
  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any)?.data;
    if (!data || typeof data !== "string") return next();

    if (!data.startsWith("books:")) return next();

    try {
      const parts = data.split(":"); // books:<action>:...
      const action = parts[1];
      
      // If user clicks anything OTHER than progress controls, cancel progress input mode
const uid = getUserId(ctx);
if (uid && action !== "progress") {
  progressDrafts.delete(uid);
}
      
      // -------------------- PROGRESS PICKER CALLBACKS --------------------
if (action === "progress" && parts[2] === "page") {
  const page = Number(parts[3] || 0) || 0;
  await ctx.answerCbQuery();
  return showProgressPicker(ctx, page);
}

if (action === "progress" && parts[2] === "pick") {
  const bookId = parts[3];
  await ctx.answerCbQuery();

  const userId = getUserId(ctx);
  if (!userId) return ctx.reply("Unauthorized.");

  const book = await Book.findOne({ _id: bookId, userId }).lean();
  if (!book) return ctx.reply("Book not found.");

  if (book.status !== "reading") {
    return ctx.reply("Progress can only be updated when status is Reading.");
  }

  progressDrafts.set(userId, { bookId: String(book._id) });

  const txt = progressPromptText(book);
  const kb = Markup.inlineKeyboard([[Markup.button.callback("Cancel", "books:progress:cancel")]]);
  if (canEditFromCtx(ctx)) return ctx.editMessageText(txt, kb);
  return ctx.reply(txt, kb);
}

if (action === "progress" && parts[2] === "cancel") {
  await ctx.answerCbQuery();
  const userId = getUserId(ctx);
  if (userId) progressDrafts.delete(userId);
  return showProgressPicker(ctx, 0);
}

      if (action === "tab") {
        const status = (parts[2] as any) || "reading";
        const page = Number(parts[3] || 0) || 0;
        await ctx.answerCbQuery();
        return showList(ctx, status, page);
      }

      if (action === "page") {
        const status = (parts[2] as any) || "reading";
        const page = Number(parts[3] || 0) || 0;
        await ctx.answerCbQuery();
        return showList(ctx, status, page);
      }

      if (action === "view") {
        const id = parts[2];
        const status = (parts[3] as any) || "reading";
        const page = Number(parts[4] || 0) || 0;
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        const book = await Book.findOne({ _id: id, userId }).lean();
        if (!book) return ctx.editMessageText("Book not found.");

        return ctx.editMessageText(
          detailsText(book),
          Markup.inlineKeyboard([
            [Markup.button.callback("Edit status", `books:pickstatus:${id}:${status}:${page}`)],
            [Markup.button.callback("Update progress", `books:progress:pick:${id}:0`)],
            [Markup.button.callback("Delete", `books:deleteconfirm:${id}:${status}:${page}`)],
            [Markup.button.callback("Back", `books:tab:${status}:${page}`)],
          ])
        );
      }

      if (action === "pick") {
        // pick list of books for view
        const status = (parts[2] as any) || "reading";
        const page = Number(parts[3] || 0) || 0;
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        const filter: any = { userId };
        if (status !== "all") filter.status = status;

        const books = await Book.find(filter).sort({ createdAt: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).lean();
        if (!books.length) return ctx.editMessageText("No books found.", listKeyboard({ status, page, hasPrev: page > 0, hasNext: false }));

        return ctx.editMessageText(
          "Tap a book:",
          pickBookKeyboard(books, "view", page, status)
        );
      }

      if (action === "pickstatus") {
        const id = parts[2];
        const status = (parts[3] as any) || "reading";
        const page = Number(parts[4] || 0) || 0;
        await ctx.answerCbQuery();

        return ctx.editMessageText(
          "Set status:",
          Markup.inlineKeyboard([
            [Markup.button.callback("TBR", `books:setstatus:${id}:tbr:${status}:${page}`)],
            [Markup.button.callback("Reading", `books:setstatus:${id}:reading:${status}:${page}`)],
            [Markup.button.callback("Finished", `books:setstatus:${id}:finished:${status}:${page}`)],
            [Markup.button.callback("Paused", `books:setstatus:${id}:paused:${status}:${page}`)],
            [Markup.button.callback("DNF", `books:setstatus:${id}:dnf:${status}:${page}`)],
            [Markup.button.callback("Back", `books:view:${id}:${status}:${page}`)],
          ])
        );
      }

      if (action === "setstatus") {
        const id = parts[2];
        const newStatus = normStatus(parts[3]);
        const listStatus = (parts[4] as any) || "reading";
        const page = Number(parts[5] || 0) || 0;
        await ctx.answerCbQuery();

        if (!newStatus) return ctx.editMessageText("Invalid status.");

        const userId = getUserId(ctx);
        const current = await Book.findOne({ _id: id, userId }).lean();
        if (!current) return ctx.editMessageText("Book not found.");

        const prog = normalizeProgress(newStatus, current.totalPages ?? null, current.currentPage ?? null);

        const updated = await Book.findOneAndUpdate(
          { _id: id, userId },
          { $set: { status: newStatus, totalPages: prog.totalPages, currentPage: prog.currentPage } },
          { new: true }
        ).lean();

        return ctx.editMessageText(detailsText(updated), Markup.inlineKeyboard([[Markup.button.callback("Back", `books:view:${id}:${listStatus}:${page}`)]]));
      }

      if (action === "deleteconfirm") {
        const id = parts[2];
        const listStatus = (parts[3] as any) || "reading";
        const page = Number(parts[4] || 0) || 0;
        await ctx.answerCbQuery();

        return ctx.editMessageText(
          "Delete this book?",
          Markup.inlineKeyboard([
            [Markup.button.callback("Delete", `books:delete:${id}:${listStatus}:${page}`)],
            [Markup.button.callback("Cancel", `books:view:${id}:${listStatus}:${page}`)],
          ])
        );
      }

      if (action === "delete") {
        const id = parts[2];
        const listStatus = (parts[3] as any) || "reading";
        const page = Number(parts[4] || 0) || 0;
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        await Book.findOneAndDelete({ _id: id, userId }).lean();

        return showList(ctx, listStatus, page);
      }

      // --- ADD FLOW ---
      if (action === "add" && parts[2] === "start") {
        await ctx.answerCbQuery();
        return startAddFlow(ctx);
      }

      if (action === "add" && parts[2] === "field") {
        // books:add:field:<fieldName>
        const field = parts[3] as AddField;
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        if (!userId) return ctx.reply("Unauthorized.");

        const draft = addDrafts.get(userId) || newDraft();
        draft.awaiting = field;
        addDrafts.set(userId, draft);

        // Keep the builder message updated
        await renderAddFlow(ctx, userId);

        // Prompt separately so it’s super clear what to type
        return ctx.reply(promptForField(field));
      }

      if (action === "add" && parts[2] === "status" && parts[3] === "menu") {
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        if (!userId) return ctx.reply("Unauthorized.");

        return ctx.editMessageText(
          "Choose status:",
          Markup.inlineKeyboard([
            [Markup.button.callback("TBR", "books:add:status:set:tbr")],
            [Markup.button.callback("Reading", "books:add:status:set:reading")],
            [Markup.button.callback("Finished", "books:add:status:set:finished")],
            [Markup.button.callback("Paused", "books:add:status:set:paused")],
            [Markup.button.callback("DNF", "books:add:status:set:dnf")],
            [Markup.button.callback("Back", "books:add:start")],
          ])
        );
      }

      if (action === "add" && parts[2] === "status" && parts[3] === "set") {
        // books:add:status:set:<status>
        const newStatus = normStatus(parts[4]);
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        if (!userId) return ctx.reply("Unauthorized.");
        if (!newStatus) return ctx.reply("Invalid status.");

        const draft = addDrafts.get(userId) || newDraft();
        draft.status = newStatus;

        // If not reading, clear progress automatically (matches your API rules)
        const prog = normalizeProgress(draft.status, draft.totalPages, draft.currentPage);
        draft.totalPages = prog.totalPages;
        draft.currentPage = prog.currentPage;

        draft.awaiting = null;
        addDrafts.set(userId, draft);

        // Go back to builder UI
        return renderAddFlow(ctx, userId);
      }

      if (action === "add" && parts[2] === "save") {
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        if (!userId) return ctx.reply("Unauthorized.");

        const draft = addDrafts.get(userId);
        if (!draft) return startAddFlow(ctx);

        const title = String(draft.title || "").trim();
        if (!title) return ctx.reply("Title is required. Tap Title and enter it.");

        const prog = normalizeProgress(draft.status, draft.totalPages, draft.currentPage);

        const created = await Book.create({
          userId,
          title,
          author: String(draft.author || "").trim(),
          status: draft.status,
          totalPages: prog.totalPages,
          currentPage: prog.currentPage,
          shortSummary: clampSummary(draft.shortSummary),
        });

        addDrafts.delete(userId);

        // Show final card-like details
        return ctx.reply(
          detailsText(created),
          Markup.inlineKeyboard([[Markup.button.callback("View list", "books:tab:reading:0")]])
        );
      }

      if (action === "add" && parts[2] === "cancel") {
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        if (!userId) return ctx.reply("Unauthorized.");

        addDrafts.delete(userId);
        return ctx.editMessageText(
          "Add cancelled.",
          Markup.inlineKeyboard([[Markup.button.callback("Back to list", "books:tab:reading:0")]])
        );
      }

      return next();
    } catch (e) {
      try {
        await ctx.answerCbQuery();
      } catch {}
      return next();
    }
  });

  // If user replies after "Edit progress" prompt, you can wire a more advanced flow later.
  // For now, /progress command is the reliable method.
}

// ---------- Internal helpers ----------
function getUserId(ctx: any): number | null {
  // If your bot middleware sets req.userId-like state, prefer it:
  const stateId = ctx.state?.userId;
  if (stateId) return Number(stateId);

  // Otherwise fallback to Telegram user id:
  const fromId = ctx.from?.id;
  if (fromId) return Number(fromId);

  return null;
}

function canEditFromCtx(ctx: any) {
  // Only safe to edit when this handler was triggered by a callback query
  // (Telegram gives you the original message to edit)
  return Boolean(ctx.callbackQuery && ctx.callbackQuery.message && typeof ctx.editMessageText === "function");
}

async function showProgressPicker(ctx: any, page: number) {
  const userId = getUserId(ctx);
  if (!userId) return ctx.reply("Unauthorized.");

  const filter: any = { userId, status: "reading" };

  const total = await Book.countDocuments(filter);
  const books = await Book.find(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  if (!books.length) {
    const txt = "No books in Reading right now.";
    const kb = Markup.inlineKeyboard([[Markup.button.callback("Back", "books:tab:reading:0")]]);
    if (canEditFromCtx(ctx)) return ctx.editMessageText(txt, kb);
    return ctx.reply(txt, kb);
  }

  const txt = "Pick a book to update progress:";
  const kb = progressPickKeyboard(books, page, hasPrev, hasNext);

  if (canEditFromCtx(ctx)) return ctx.editMessageText(txt, kb);
  return ctx.reply(txt, kb);
}

async function showList(ctx: any, status: BookStatus | "all", page: number) {
  const userId = getUserId(ctx);
  if (!userId) return ctx.reply("Unauthorized.");

  const filter: any = { userId };
  if (status !== "all") filter.status = status;

  const total = await Book.countDocuments(filter);
  const books = await Book.find(filter)
    .sort({ createdAt: -1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  if (!books.length) {
    const txt =
      status === "all"
        ? "No books yet."
        : `No books in ${statusLabel(status as BookStatus)}.`;

    if (canEditFromCtx(ctx)) {
      return ctx.editMessageText(txt, listKeyboard({ status, page, hasPrev, hasNext }));
    }
    return ctx.reply(txt, listKeyboard({ status, page, hasPrev, hasNext }));
  }

  const lines: string[] = [];
  lines.push(`Books: ${status === "all" ? "All" : statusLabel(status as BookStatus)}`);
  lines.push(`Page ${page + 1}`);

  for (const b of books) {
    lines.push("");
    lines.push(bookLabel(b));
    lines.push(`Status: ${statusLabel(b.status)}`);
    if (b.status === "reading") lines.push(progressLabel(b));
    const sum = String(b.shortSummary || "").trim();
    if (sum) lines.push(sum);
    lines.push(`Id: ${String(b._id)}`);
  }

  const kb = Markup.inlineKeyboard([
    ...listKeyboard({ status, page, hasPrev, hasNext }).reply_markup.inline_keyboard,
    [Markup.button.callback("Open picker", `books:pick:${status}:${page}`)],
  ]);

  if (canEditFromCtx(ctx)) return ctx.editMessageText(lines.join("\n"), kb);
  return ctx.reply(lines.join("\n"), kb);
}