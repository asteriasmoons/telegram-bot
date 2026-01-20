import { Telegraf, Markup } from "telegraf";
import { listEvents, deleteEvent } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

const CB = {
  CANCEL: "ev:del:cancel",
  PICK_PREFIX: "ev:del:pick:", // + <eventId>
  CONFIRM_YES: "ev:del:yes",
  CONFIRM_NO: "ev:del:no",
  REFRESH: "ev:del:refresh",
} as const;

function pickKeyboard(events: any[]) {
  const rows: any[] = [];

  for (let i = 0; i < events.length; i += 2) {
    const a = events[i];
    const b = events[i + 1];

    const row = [
      Markup.button.callback(`${(a.title || "Untitled").slice(0, 20)}`, `${CB.PICK_PREFIX}${a._id}`),
    ];
    if (b) row.push(Markup.button.callback(`${(b.title || "Untitled").slice(0, 20)}`, `${CB.PICK_PREFIX}${b._id}`));

    rows.push(row);
  }

  rows.push([Markup.button.callback("Refresh", CB.REFRESH)]);
  rows.push([Markup.button.callback("Cancel", CB.CANCEL)]);

  return Markup.inlineKeyboard(rows);
}

async function sendPickList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 20 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to delete.");
    return;
  }

  await ctx.reply("Pick an event to delete:", pickKeyboard(events));
}

export function register(bot: Telegraf) {
  bot.command("eventdelete", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    setState(userId, { kind: "event_delete", step: "pick", draft: {} });

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      clearState(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.REFRESH, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_delete") return;

    await ctx.answerCbQuery();

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      clearState(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(new RegExp(`^${CB.PICK_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_delete") return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB.PICK_PREFIX.length);

    await ctx.answerCbQuery();

    setState(userId, { kind: "event_delete", step: "confirm", draft: { eventId } });

    await ctx.reply(
      `Delete this event?\nID: ${eventId}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete", CB.CONFIRM_YES)],
        [Markup.button.callback("No, cancel", CB.CONFIRM_NO)],
      ])
    );
  });

  bot.action(CB.CONFIRM_NO, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const st: any = getState(userId);
    if (!st || st.kind !== "event_delete" || st.step !== "confirm") return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB.CONFIRM_YES, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const st: any = getState(userId);
    if (!st || st.kind !== "event_delete" || st.step !== "confirm") return;

    const eventId = st.draft?.eventId;
    if (!eventId) return;

    await ctx.answerCbQuery();

    try {
      await deleteEvent(userId, eventId);
      clearState(userId);
      await ctx.reply("Event deleted.");
    } catch (e: any) {
      await ctx.reply(`Failed to delete: ${e?.message ?? "Unknown error"}`);
    }
  });
}