import { Telegraf, Markup } from "telegraf";
import { listEvents, deleteEvent } from "../services/events.service";

/**
 * In-memory flow state (no conversationStore).
 * Resets on bot restart -- acceptable for short interactive flows.
 */
type Step = "pick_event" | "confirm";

type DeleteFlowState = {
  step: Step;
  eventId?: string;
};

const flow = new Map<number, DeleteFlowState>();

function requireUser(ctx: any): number | null {
  const userId = ctx.from?.id;
  return typeof userId === "number" ? userId : null;
}

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

const CB = {
  CANCEL: "ev:del:cancel",
  REFRESH: "ev:del:refresh",
  PICK_PREFIX: "ev:del:pick:",

  CONFIRM_YES: "ev:del:confirm:yes",
  CONFIRM_NO: "ev:del:confirm:no",
} as const;

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendPickList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 60);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 24 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to delete.");
    return;
  }

  const rows: any[] = [];
  const pairs = chunk(events, 2);

  for (const pair of pairs) {
    const row: any[] = [];
    for (const ev of pair) {
      const label = `${(ev.title || "Untitled").slice(0, 18)}`;
      row.push(Markup.button.callback(label, `${CB.PICK_PREFIX}${ev._id}`));
    }
    rows.push(row);
  }

  rows.push([Markup.button.callback("Refresh list", CB.REFRESH)]);
  rows.push([Markup.button.callback("Cancel", CB.CANCEL)]);

  await ctx.reply("Pick an event to delete:", Markup.inlineKeyboard(rows));
}

export function register(bot: Telegraf) {
  // /eventdelete
  bot.command("eventdelete", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.set(userId, { step: "pick_event" });

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Cancel
  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  // Refresh
  bot.action(CB.REFRESH, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st) return;

    st.step = "pick_event";
    st.eventId = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Pick event
  bot.action(new RegExp(`^${CB.PICK_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || st.step !== "pick_event") return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB.PICK_PREFIX.length);

    st.step = "confirm";
    st.eventId = eventId;
    flow.set(userId, st);

    await ctx.answerCbQuery();

    await ctx.reply(
      `Delete this event?\nID: ${eventId}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete", CB.CONFIRM_YES)],
        [Markup.button.callback("No, cancel", CB.CONFIRM_NO)],
      ])
    );
  });

  // Confirm no
  bot.action(CB.CONFIRM_NO, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st) return;

    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  // Confirm yes -> delete
  bot.action(CB.CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || st.step !== "confirm" || !st.eventId) return;

    await ctx.answerCbQuery();

    try {
      await deleteEvent(userId, st.eventId);
      flow.delete(userId);
      await ctx.reply("Event deleted.");
    } catch (e: any) {
      // keep them in flow so they can retry
      st.step = "pick_event";
      st.eventId = undefined;
      flow.set(userId, st);

      await ctx.reply(`Failed to delete: ${e?.message ?? "Unknown error"}`);
      try {
        await sendPickList(ctx, userId);
      } catch {
        // ignore
      }
    }
  });
}