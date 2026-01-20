import { Telegraf, Markup } from "telegraf";
import { listEvents } from "../services/events.service";

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
  RANGE_7: "ev:list:range:7",
  RANGE_30: "ev:list:range:30",
  RANGE_90: "ev:list:range:90",
  REFRESH_30: "ev:list:refresh:30",
  CLOSE: "ev:list:close",
} as const;

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtWhen(ev: any) {
  const start = new Date(ev.startDate);
  if (ev.allDay) return `${fmtDate(start)} (all day)`;
  return `${fmtDate(start)} at ${fmtTime(start)}`;
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function headerKeyboard(selectedDays: number) {
  const label = (days: number) => (selectedDays === days ? `Next ${days} days ✓` : `Next ${days} days`);
  return Markup.inlineKeyboard([
    [Markup.button.callback(label(7), CB.RANGE_7), Markup.button.callback(label(30), CB.RANGE_30)],
    [Markup.button.callback(label(90), CB.RANGE_90), Markup.button.callback("Refresh", CB.REFRESH_30)],
    [Markup.button.callback("Close", CB.CLOSE)],
  ]);
}

async function sendList(ctx: any, userId: number, days: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 50 });

  await ctx.reply(`Events (next ${days} days): ${events.length}`, headerKeyboard(days));

  if (!events.length) {
    await ctx.reply("No events found in that range.");
    return;
  }

  // Send in small chunks so Telegram doesn’t choke, and your chat doesn’t become unreadable
  const groups = chunk(events, 5);

  for (const group of groups) {
    const lines: string[] = [];
    for (const ev of group) {
      lines.push(
        [
          `• ${ev.title || "Untitled"}`,
          `  When: ${fmtWhen(ev)}`,
          ev.location ? `  Where: ${ev.location}` : null,
          `  ID: ${ev._id}`,
        ].filter(Boolean).join("\n")
      );
    }

    await ctx.reply(lines.join("\n\n"));
  }

  await ctx.reply(
    "Want to change something?",
    Markup.inlineKeyboard([
      [Markup.button.callback("Edit (use /eventedit)", "noop:edit")],
      [Markup.button.callback("Delete (use /eventdelete)", "noop:delete")],
    ])
  );
}

export function register(bot: Telegraf) {
  // /eventlist
  bot.command("eventlist", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    try {
      await sendList(ctx, userId, 30);
    } catch (e: any) {
      await ctx.reply(`Failed to list events: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Range/refresh buttons
  bot.action([CB.RANGE_7, CB.RANGE_30, CB.RANGE_90, CB.REFRESH_30], async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const data = getCbData(ctx);
    if (!data) return;

    await ctx.answerCbQuery();

    let days = 30;
    if (data === CB.RANGE_7) days = 7;
    if (data === CB.RANGE_30) days = 30;
    if (data === CB.RANGE_90) days = 90;
    if (data === CB.REFRESH_30) days = 30;

    try {
      await sendList(ctx, userId, days);
    } catch (e: any) {
      await ctx.reply(`Failed to list events: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.CLOSE, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Closed.");
  });

  // These are just informational buttons so users understand the flow
  bot.action(["noop:edit", "noop:delete"], async (ctx) => {
    const data = getCbData(ctx);
    await ctx.answerCbQuery();

    if (data === "noop:edit") return ctx.reply("Run /eventedit to edit with buttons.");
    if (data === "noop:delete") return ctx.reply("Run /eventdelete to delete with buttons.");
  });
}