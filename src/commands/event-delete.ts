import { Telegraf, Markup } from "telegraf";
import { DateTime } from "luxon";

import { Event } from "../models/Event";
import { UserSettings } from "../models/UserSettings";
import { Reminder } from "../models/Reminder"; // <-- adjust if your filename differs

/**
 * /eventdelete
 * Button-driven delete flow:
 * - Show paginated list of all events
 * - User taps one to delete
 * - Confirm delete (and mention linked reminder)
 * - Delete event + linked reminder (if any)
 * - Return to list
 */

const PAGE_SIZE = 7;

const PICK_PREFIX = "ev:del:pick:";
const CONFIRM_PREFIX = "ev:del:confirm:";

const CB = {
  PAGE_PREV: "ev:del:page:prev",
  PAGE_NEXT: "ev:del:page:next",
  REFRESH: "ev:del:refresh",
  CLOSE: "ev:del:close",
  CANCEL: "ev:del:cancel",
} as const;

type DeleteState = {
  page: number;
  pickEventId?: string;
};

const state = new Map<number, DeleteState>();

function requireUser(ctx: any): number | null {
  const userId = ctx.from?.id;
  return typeof userId === "number" ? userId : null;
}

async function getTimezone(userId: number): Promise<string> {
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

function safeId(id: any): string {
  return typeof id === "string" ? id : String(id);
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatWhen(ev: any, tz: string): string {
  const start = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });
  if (ev.allDay) return `${start.toFormat("MMM d, yyyy")} (all day)`;
  return start.toFormat("MMM d, yyyy h:mm a");
}

function buttonLabel(ev: any, tz: string): string {
  const start = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });

  const when = ev.allDay
    ? `${start.toFormat("MMM d")} • All day`
    : `${start.toFormat("MMM d")} • ${start.toFormat("h:mm a")}`;

  const title = clip(String(ev.title || "Untitled"), 24);
  return `${when} -- ${title}`;
}

async function fetchEventsPage(userId: number, skip: number, limit: number) {
  const docs = await Event.find({ userId })
    .sort({ startDate: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return docs as any[];
}

async function renderPickMenu(ctx: any, userId: number) {
  const tz = await getTimezone(userId);
  const st = state.get(userId) || { page: 0 };
  const page = Math.max(0, st.page || 0);

  const skip = page * PAGE_SIZE;
  const docs = await fetchEventsPage(userId, skip, PAGE_SIZE + 1);

  const hasNext = docs.length > PAGE_SIZE;
  const events = docs.slice(0, PAGE_SIZE);

  if (events.length === 0) {
    state.set(userId, { page: 0 });
    return ctx.reply(
      "You have no events to delete.",
      Markup.inlineKeyboard([[Markup.button.callback("Close", CB.CLOSE)]])
    );
  }

  const rows: any[] = events.map((ev) => [
    Markup.button.callback(buttonLabel(ev, tz), `${PICK_PREFIX}${safeId(ev._id)}`),
  ]);

  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback("‹ Prev", CB.PAGE_PREV));
  if (hasNext) navRow.push(Markup.button.callback("Next ›", CB.PAGE_NEXT));
  if (navRow.length) rows.push(navRow);

  rows.push([
    Markup.button.callback("Refresh", CB.REFRESH),
    Markup.button.callback("Close", CB.CLOSE),
  ]);

  state.set(userId, { ...st, page });

  return ctx.reply(`Pick an event to delete (page ${page + 1}):`, Markup.inlineKeyboard(rows));
}

async function renderConfirm(ctx: any, userId: number, eventId: string) {
  const tz = await getTimezone(userId);

  const ev = await Event.findOne({ _id: eventId, userId }).lean();
  if (!ev) {
    return ctx.reply(
      "That event could not be found. Try again.",
      Markup.inlineKeyboard([[Markup.button.callback("Back to list", CB.REFRESH)]])
    );
  }

  const title = String(ev.title || "Untitled");
  const when = formatWhen(ev, tz);
  const hasReminder = !!ev.reminderId;

  const text =
    `Delete this event?\n\n` +
    `Title: ${title}\n` +
    `When: ${when}\n` +
    (ev.location ? `Location: ${String(ev.location)}\n` : "") +
    (hasReminder ? `Linked reminder: Yes (will also be deleted)\n` : `Linked reminder: No\n`);

  return ctx.reply(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("Delete", `${CONFIRM_PREFIX}${eventId}`)],
      [Markup.button.callback("Cancel", CB.CANCEL)],
    ])
  );
}

async function deleteEventAndLinkedReminder(userId: number, eventId: string) {
  const ev = await Event.findOne({ _id: eventId, userId }).lean();
  if (!ev) return { ok: false as const, reason: "not_found" as const };

  const reminderId = ev.reminderId ? safeId(ev.reminderId) : null;

  await Event.deleteOne({ _id: eventId, userId });

  if (reminderId) {
    // Only delete if your Reminder model supports userId scoping (yours likely does)
    await Reminder.deleteOne({ _id: reminderId, userId });
  }

  return { ok: true as const, deletedReminder: !!reminderId };
}

export function register(bot: Telegraf) {
  bot.command("eventdelete", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    state.set(userId, { page: 0 });
    await renderPickMenu(ctx, userId);
  });

  bot.action(CB.PAGE_PREV, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();

    const st = state.get(userId) || { page: 0 };
    st.page = Math.max(0, (st.page || 0) - 1);
    state.set(userId, st);

    await renderPickMenu(ctx, userId);
  });

  bot.action(CB.PAGE_NEXT, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();

    const st = state.get(userId) || { page: 0 };
    st.page = (st.page || 0) + 1;
    state.set(userId, st);

    await renderPickMenu(ctx, userId);
  });

  bot.action(CB.REFRESH, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();
    await renderPickMenu(ctx, userId);
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();
    await renderPickMenu(ctx, userId);
  });

  bot.action(CB.CLOSE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    state.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Closed.");
  });

  // Pick event -> confirm
  bot.action(new RegExp(`^${PICK_PREFIX}(.+)$`), async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const data = (ctx.callbackQuery as any).data as string;
    const eventId = data.replace(PICK_PREFIX, "");

    await ctx.answerCbQuery();

    const st = state.get(userId) || { page: 0 };
    st.pickEventId = eventId;
    state.set(userId, st);

    await renderConfirm(ctx, userId, eventId);
  });

  // Confirm delete
  bot.action(new RegExp(`^${CONFIRM_PREFIX}(.+)$`), async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const data = (ctx.callbackQuery as any).data as string;
    const eventId = data.replace(CONFIRM_PREFIX, "");

    await ctx.answerCbQuery();

    const res = await deleteEventAndLinkedReminder(userId, eventId);

    if (!res.ok) {
      return ctx.reply(
        "That event could not be found. Try again.",
        Markup.inlineKeyboard([[Markup.button.callback("Refresh", CB.REFRESH)]])
      );
    }

    await ctx.reply(res.deletedReminder ? "Event (and linked reminder) deleted." : "Event deleted.");

    // Return to list
    await renderPickMenu(ctx, userId);
  });
}