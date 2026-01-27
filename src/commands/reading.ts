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

function normalizeProgress(status: BookStatus, totalPages: number | null, currentPage: number | null) {
  if (status !== "reading") return { totalPages: null, currentPage: null };

  if (totalPages !== null && totalPages <= 0) totalPages = null;

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
  // /bookadd Title | Author | status | totalPages | currentPage | shortSummary
  bot.command("bookadd", async (ctx) => {
    const userId = getUserId(ctx);
    if (!userId) return ctx.reply("Unauthorized.");

    const raw = (ctx.message?.text || "").replace(/^\/bookadd(@\w+)?/i, "").trim();
    if (!raw) {
      return ctx.reply(
        [
          "Usage:",
          "/bookadd Title | Author | status | totalPages | currentPage | shortSummary",
          "",
          "Examples:",
          "/bookadd The Hobbit | Tolkien | tbr",
          "/bookadd Iron Flame | Yarros | reading | 640 | 120 | Two short sentences here.",
        ].join("\n")
      );
    }

    const parts = raw.split("|").map((s) => s.trim());
    const title = String(parts[0] || "").trim();
    const author = String(parts[1] || "").trim();
    const status = normStatus(parts[2] || "tbr") || "tbr";
    const totalPages = toIntOrNull(parts[3]);
    const currentPage = toIntOrNull(parts[4]);
    const shortSummary = clampSummary(parts.slice(5).join("|"));

    if (!title) return ctx.reply("Title is required.");

    const prog = normalizeProgress(status, totalPages, currentPage);

    const created = await Book.create({
      userId,
      title,
      author,
      status,
      totalPages: prog.totalPages,
      currentPage: prog.currentPage,
      shortSummary,
    });

    return ctx.reply(detailsText(created), Markup.inlineKeyboard([[Markup.button.callback("View list", "books:tab:reading:0")]]));
  });

  // Update progress:
  // /progress <bookId> <currentPage> [totalPages]
  bot.command("progress", async (ctx) => {
    const userId = getUserId(ctx);
    if (!userId) return ctx.reply("Unauthorized.");

    const raw = (ctx.message?.text || "").replace(/^\/progress(@\w+)?/i, "").trim();
    const parts = raw.split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      return ctx.reply(
        [
          "Usage:",
          "/progress <bookId> <currentPage> [totalPages]",
          "",
          "Tip: use /books then tap Edit to copy the book id.",
        ].join("\n")
      );
    }

    const id = parts[0];
    const currentPage = toIntOrNull(parts[1]);
    const totalPages = parts.length >= 3 ? toIntOrNull(parts[2]) : null;

    if (currentPage === null) return ctx.reply("Current page must be a non-negative number.");

    const book = await Book.findOne({ _id: id, userId }).lean();
    if (!book) return ctx.reply("Book not found.");

    const status = (book.status as BookStatus) || "tbr";
    if (status !== "reading") return ctx.reply("Progress can only be set when status is Reading.");

    const tp = totalPages !== null ? totalPages : (book.totalPages ?? null);
    const prog = normalizeProgress("reading", tp, currentPage);

    const updated = await Book.findOneAndUpdate(
      { _id: id, userId },
      { $set: { totalPages: prog.totalPages, currentPage: prog.currentPage } },
      { new: true }
    ).lean();

    return ctx.reply(detailsText(updated));
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

  // ---------- Callback handlers (UI-like flow) ----------
  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any)?.data;
    if (!data || typeof data !== "string") return next();

    if (!data.startsWith("books:")) return next();

    try {
      const parts = data.split(":"); // books:<action>:...
      const action = parts[1];

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
            [Markup.button.callback("Edit progress", `books:pickprogress:${id}:${status}:${page}`)],
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

      if (action === "pickprogress") {
        const id = parts[2];
        const listStatus = (parts[3] as any) || "reading";
        const page = Number(parts[4] || 0) || 0;
        await ctx.answerCbQuery();

        const userId = getUserId(ctx);
        const book = await Book.findOne({ _id: id, userId }).lean();
        if (!book) return ctx.editMessageText("Book not found.");
        if (book.status !== "reading") {
          return ctx.editMessageText(
            "Progress can only be set when status is Reading.",
            Markup.inlineKeyboard([[Markup.button.callback("Back", `books:view:${id}:${listStatus}:${page}`)]])
          );
        }

        return ctx.editMessageText(
          [
            "Reply with:",
            "<currentPage> [totalPages]",
            "",
            "Example: 120 640",
            "Example: 85",
            "",
            `Book id: ${id}`,
          ].join("\n"),
          Markup.inlineKeyboard([[Markup.button.callback("Back", `books:view:${id}:${listStatus}:${page}`)]])
        );
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

      if (action === "add" && parts[2] === "start") {
        await ctx.answerCbQuery();
        return ctx.editMessageText(
          [
            "Add a book:",
            "Use /bookadd Title | Author | status | totalPages | currentPage | shortSummary",
            "",
            "Example:",
            "/bookadd The Hobbit | Tolkien | tbr",
          ].join("\n"),
          Markup.inlineKeyboard([[Markup.button.callback("Back", "books:tab:reading:0")]])
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

    // edit if possible, otherwise reply
    if (ctx.editMessageText) {
      return ctx.editMessageText(txt, listKeyboard({ status, page, hasPrev, hasNext }));
    }
    return ctx.reply(txt, listKeyboard({ status, page, hasPrev, hasNext }));
  }

  const lines: string[] = [];
  lines.push(`Books: ${status === "all" ? "All" : statusLabel(status as BookStatus)}`);
  lines.push(`Page ${page + 1}`);

  // Show compact list like the mini app cards
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

  if (ctx.editMessageText) return ctx.editMessageText(lines.join("\n"), kb);
  return ctx.reply(lines.join("\n"), kb);
}