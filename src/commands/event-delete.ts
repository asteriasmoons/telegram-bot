import { Telegraf, Markup } from "telegraf";
import { listEvents, deleteEvent } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";

const CB_PICK_EVENT_PREFIX = "ev:del:pick:"; // + <eventId>
const CB_CONFIRM_YES = "ev:del:yes";
const CB_CONFIRM_NO = "ev:del:no";

async function sendPickEventList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 20 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to delete.");
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < events.length; i += 2) {
    const a = events[i];
    const b = events[i + 1];

    const row = [
      Markup.button.callback(
        `${(a.title || "Untitled").slice(0, 20)}`,
        `${CB_PICK_EVENT_PREFIX}${a._id}`
      ),
    ];

    if (b) {
      row.push(
        Markup.button.callback(
          `${(b.title || "Untitled").slice(0, 20)}`,
          `${CB_PICK_EVENT_PREFIX}${b._id}`
        )
      );
    }

    rows.push(row);
  }

  rows.push([Markup.button.callback("Cancel", CB_CONFIRM_NO)]);

  await ctx.reply("Which event do you want to delete?", Markup.inlineKeyboard(rows));
}

export function register(bot: Telegraf) {
  bot.command("eventdelete", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    setState(userId, {
      kind: "event_delete",
      step: "pick_event",
      draft: {},
    });

    try {
      await sendPickEventList(ctx, userId);
    } catch (err: any) {
      await ctx.reply(`Failed to load events: ${err?.message ?? "Unknown error"}`);
      clearState(userId);
    }
  });

  bot.action(new RegExp(`^${CB_PICK_EVENT_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_delete" || state.step !== "pick_event") return;

    const data = ctx.callbackQuery.data;
    const eventId = data.slice(CB_PICK_EVENT_PREFIX.length);

    state.draft.eventId = eventId;
    state.step = "confirm";
    setState(userId, state);

    await ctx.answerCbQuery();
    await ctx.reply(
      `Delete this event?\nID: ${eventId}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete", CB_CONFIRM_YES)],
        [Markup.button.callback("No, cancel", CB_CONFIRM_NO)],
      ])
    );
  });

  bot.action(CB_CONFIRM_NO, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB_CONFIRM_YES, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_delete" || state.step !== "confirm") return;

    const eventId = state.draft.eventId;
    if (!eventId) return;

    await ctx.answerCbQuery();

    try {
      await deleteEvent(userId, eventId);
      clearState(userId);
      await ctx.reply("Event deleted.");
    } catch (err: any) {
      await ctx.reply(`Failed to delete event: ${err?.message ?? "Unknown error"}`);
      // keep state so they can cancel or try again
    }
  });
}