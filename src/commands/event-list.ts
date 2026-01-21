import { Telegraf, Markup } from "telegraf";
import mongoose from "mongoose";
import { DateTime } from "luxon";

/**
 * /eventlist
 * Lists ALL events (no date filtering)
 * - Paginated
 * - Each event button routes into event-edit (uses ev:edit:pick:<id>)
 * - Uses Luxon + user timezone for display
 */

const PAGE_SIZE = 7;

// Must match the prefix in event-edit.ts so clicking an event jumps into edit flow
const EDIT_PICK_PREFIX = "ev:edit:pick:";

const CB = {
  PAGE_PREV: "ev:list:page:prev",
  PAGE_NEXT: "ev:list:page:next",
  REFRESH: "ev:list:refresh",
  CLOSE: "ev:list:close",
} as const;

type ListState = {
  page: number;
};

const state = new Map<number, ListState>();

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

function requireUser(ctx: any): number | null {
  const userId = ctx.from?.id;
  return typeof userId === "number" ? userId : null;
}

async function getTimezone(userId: number): Promise<string> {
  const UserSettings = (mongoose.models as any).UserSettings;
  if (!UserSettings) return "America/Chicago";
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

async function fetchEvents(userId: number, skip: number, limit: number) {
  const EventModel = (mongoose.models as any).Event;
  if (!EventModel) throw new Error("Event model not registered");

  // pull one extra to detect next page
  const docs = await EventModel.find({ userId })
    .sort({ startDate: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return docs as any[];
}

function formatLine(ev: any, tz: string): string {
  const start = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });

  const when = ev.allDay
    ? start.toFormat("MMM d, yyyy") + " (all day)"
    : start.toFormat("MMM d, yyyy h:mm a");

  const title = (ev.title || "Untitled").toString();
  const loc = ev.location ? ` -- ${String(ev.location)}` : "";
  return `${when} -- ${title}${loc}`;
}

function buttonLabel(ev: any, tz: string): string {
  const start = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });

  const when = ev.allDay
    ? start.toFormat("MMM d") + " • All day"
    : start.toFormat("MMM d") + " • " + start.toFormat("h:mm a");

  const title = (ev.title || "Untitled").toString();
  const clipped = title.length > 24 ? title.slice(0, 24) + "…" : title;

  return `${when} -- ${clipped}`;
}

async function renderList(ctx: any, userId: number) {
  const tz = await getTimezone(userId);

  const st = state.get(userId) || { page: 0 };
  const page = Math.max(0, st.page || 0);

  const skip = page * PAGE_SIZE;
  const docs = await fetchEvents(userId, skip, PAGE_SIZE + 1);

  const hasNext = docs.length > PAGE_SIZE;
  const events = docs.slice(0, PAGE_SIZE);

  if (events.length === 0) {
    state.set(userId, { page: 0 });
    return ctx.reply(
      "You have no events yet.\n\nTip: create one in the mini app, then come back here to edit it with buttons.",
      Markup.inlineKeyboard([[Markup.button.callback("Close", CB.CLOSE)]])
    );
  }

  const lines = events.map((ev) => `• ${formatLine(ev, tz)}`).join("\n");

  const rows: any[] = events.map((ev) => [
    // Clicking this will be handled by event-edit.ts because it matches its pick regex
    Markup.button.callback(buttonLabel(ev, tz), `${EDIT_PICK_PREFIX}${String(ev._id)}`),
  ]);

  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback("‹ Prev", CB.PAGE_PREV));
  if (hasNext) navRow.push(Markup.button.callback("Next ›", CB.PAGE_NEXT));
  if (navRow.length) rows.push(navRow);

  rows.push([
    Markup.button.callback("Refresh", CB.REFRESH),
    Markup.button.callback("Close", CB.CLOSE),
  ]);

  state.set(userId, { page });

  return ctx.reply(`Events (page ${page + 1}):\n\n${lines}`, Markup.inlineKeyboard(rows));
}

export function register(bot: Telegraf) {
  bot.command("eventlist", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    state.set(userId, { page: 0 });
    await renderList(ctx, userId);
  });

  bot.action(CB.PAGE_PREV, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();

    const st = state.get(userId) || { page: 0 };
    st.page = Math.max(0, (st.page || 0) - 1);
    state.set(userId, st);

    await renderList(ctx, userId);
  });

  bot.action(CB.PAGE_NEXT, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();

    const st = state.get(userId) || { page: 0 };
    st.page = (st.page || 0) + 1;
    state.set(userId, st);

    await renderList(ctx, userId);
  });

  bot.action(CB.REFRESH, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    await ctx.answerCbQuery();

    // keep current page, just reload
    await renderList(ctx, userId);
  });

  bot.action(CB.CLOSE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    state.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Closed.");
  });
}