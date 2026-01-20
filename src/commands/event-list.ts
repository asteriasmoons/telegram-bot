import { Telegraf, Markup } from "telegraf";
import { listEvents } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

const CB = {
  CANCEL: "ev:list:cancel",
  RANGE_7: "ev:list:range:7",
  RANGE_30: "ev:list:range:30",
  RANGE_90: "ev:list:range:90",
  REFRESH: "ev:list:refresh",
  EDIT_FROM_LIST_PREFIX: "ev:list:edit:",   // + <eventId>
  DELETE_FROM_LIST_PREFIX: "ev:list:del:",  // + <eventId>
} as const;

function fmtWhen(e: any) {
  const d = new Date(e.startDate);
  if (e.allDay) return `${d.toLocaleDateString()} (all day)`;
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  } as any);
}

function safeLine(s?: string) {
  return (s || "").trim();
}

function listMenuKeyboard(days: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(days === 7 ? "Next 7 days ✓" : "Next 7 days", CB.RANGE_7),
      Markup.button.callback(days === 30 ? "Next 30 days ✓" : "Next 30 days", CB.RANGE_30),
    ],
    [
      Markup.button.callback(days === 90 ? "Next 90 days ✓" : "Next 90 days", CB.RANGE_90),
      Markup.button.callback("Refresh", CB.REFRESH),
    ],
    [Markup.button.callback("Close", CB.CANCEL)],
  ]);
}

async function sendList(ctx: any, userId: number) {
  const state: any = getState(userId);
  const days: number = state?.draft?.days ?? 30;

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 50 });

  await ctx.reply(
    `Event list (next ${days} days): ${events.length}\nChoose a range or refresh:`,
    listMenuKeyboard(days)
  );

  if (!events.length) {
    await ctx.reply("No events found in that range.");
    return;
  }

  for (const ev of events) {
    const when = fmtWhen(ev);
    const title = safeLine(ev.title) || "(Untitled)";
    const loc = safeLine(ev.location);
    const desc = safeLine(ev.description);

    const lines = [
      `ID: ${ev._id}`,
      `${when}`,
      `${title}`,
      loc ? `Location: ${loc}` : null,
      desc ? `Description: ${desc}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await ctx.reply(
      lines,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Edit", `${CB.EDIT_FROM_LIST_PREFIX}${ev._id}`),
          Markup.button.callback("Delete", `${CB.DELETE_FROM_LIST_PREFIX}${ev._id}`),
        ],
      ])
    );
  }
}

export function register(bot: Telegraf) {
  bot.command("eventlist", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // This is a "view" flow, so we can clear other states safely if you want:
    // clearState(userId);

    setState(userId, { kind: "event_list", step: "menu", draft: { days: 30 } });

    try {
      await sendList(ctx, userId);
    } catch (e: any) {
      await ctx.reply(`Failed to list events: ${e?.message ?? "Unknown error"}`);
      clearState(userId);
    }
  });

  bot.action([CB.RANGE_7, CB.RANGE_30, CB.RANGE_90, CB.REFRESH], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_list") return;

    const data = getCbData(ctx);
    if (!data) return;

    await ctx.answerCbQuery();

    if (data === CB.RANGE_7) state.draft.days = 7;
    if (data === CB.RANGE_30) state.draft.days = 30;
    if (data === CB.RANGE_90) state.draft.days = 90;

    setState(userId, state);

    try {
      await sendList(ctx, userId);
    } catch (e: any) {
      await ctx.reply(`Failed to list events: ${e?.message ?? "Unknown error"}`);
      clearState(userId);
    }
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Closed.");
  });

  // Route Edit -> tell them to use /eventedit (or we could auto-start edit flow if you prefer later)
  bot.action(new RegExp(`^${CB.EDIT_FROM_LIST_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Run /eventedit to edit events (pick the event from the buttons).");
  });

  // Route Delete -> auto-start delete flow with that ID (button-driven)
  bot.action(new RegExp(`^${CB.DELETE_FROM_LIST_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB.DELETE_FROM_LIST_PREFIX.length);

    await ctx.answerCbQuery();

    // Put them into delete confirm state directly:
    setState(userId, { kind: "event_delete", step: "confirm", draft: { eventId } });

    await ctx.reply(
      `Delete this event?\nID: ${eventId}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete", "ev:del:yes")],
        [Markup.button.callback("No, cancel", "ev:del:no")],
      ])
    );
  });

  // These two handlers are shared with event-delete.ts and intentionally duplicated-safe.
  bot.action("ev:del:no", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const st: any = getState(userId);
    if (!st || st.kind !== "event_delete" || st.step !== "confirm") return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });
}