// src/bot/readingStreaks.ts
import { Telegraf, Context } from "telegraf";
import { ReadingStreak } from "../models/ReadingStreak";
import { UserSettings } from "../models/UserSettings";

/**
 * Slash-command entry + button-driven reading streak panel.
 *
 * Slash commands:
 * - /readingstreak  -> opens panel
 * - /streak         -> alias, opens panel
 *
 * Buttons:
 * - Check in for today
 * - Reset streak (requires typing RESET)
 * - Close
 */

// ----------------------------
// Helpers (timezone + date keys)
// ----------------------------

async function getTimezoneForUser(userId: number): Promise<string> {
  const s = await UserSettings.findOne({ userId }).lean();
  return String(s?.timezone || "America/Chicago");
}

// returns "YYYY-MM-DD" in the user's timezone
function dateKeyInTz(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// given "YYYY-MM-DD", return yesterday "YYYY-MM-DD"
function yesterdayKeyFromTodayKey(todayKey: string): string {
  const [y, m, d] = todayKey.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const prev = new Date(utc - 86400000);
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(prev.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

type StreakView = {
  currentStreak: number;
  bestStreak: number;
  lastCheckInDate: string | null;
  checkedInToday: boolean;
  todayKey: string;
  tz: string;
};

async function getOrCreateStreakDoc(userId: number) {
  let doc = await ReadingStreak.findOne({ userId });
  if (!doc) {
    doc = await ReadingStreak.create({
      userId,
      currentStreak: 0,
      bestStreak: 0,
      lastCheckInDate: null,
    });
  }
  return doc;
}

async function getStreakView(userId: number): Promise<StreakView> {
  const tz = await getTimezoneForUser(userId);
  const todayKey = dateKeyInTz(tz);

  const doc = await getOrCreateStreakDoc(userId);
  const obj = doc.toObject();

  return {
    currentStreak: obj.currentStreak || 0,
    bestStreak: obj.bestStreak || 0,
    lastCheckInDate: obj.lastCheckInDate || null,
    checkedInToday: obj.lastCheckInDate === todayKey,
    todayKey,
    tz,
  };
}

// ----------------------------
// Inline keyboard
// ----------------------------

function streakKeyboard(checkedInToday: boolean) {
  const checkInLabel = checkedInToday ? "Checked in today" : "Check in for today";

  return {
    inline_keyboard: [
      [{ text: checkInLabel, callback_data: "rdstreak:checkin" }],
      [{ text: "Reset streak", callback_data: "rdstreak:reset" }],
      [{ text: "Close", callback_data: "rdstreak:close" }],
    ],
  };
}

function formatStreakMessage(v: StreakView) {
  return [
    "Reading streak",
    "",
    `Current streak: ${v.currentStreak}`,
    `Best streak: ${v.bestStreak}`,
    `Last check-in: ${v.lastCheckInDate ?? "Never"}`,
    `Today: ${v.todayKey}`,
  ].join("\n");
}

// ----------------------------
// Button -> user types state
// ----------------------------

type AwaitingKind = "reset_confirm";

const awaiting = new Map<number, { kind: AwaitingKind; startedAt: number }>();

function setAwaiting(userId: number, kind: AwaitingKind) {
  awaiting.set(userId, { kind, startedAt: Date.now() });
}

function clearAwaiting(userId: number) {
  awaiting.delete(userId);
}

function getAwaiting(userId: number) {
  const a = awaiting.get(userId);
  if (!a) return null;

  // expire after 10 minutes
  if (Date.now() - a.startedAt > 10 * 60_000) {
    awaiting.delete(userId);
    return null;
  }

  return a;
}

// ----------------------------
// Core actions
// ----------------------------

async function openPanel(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const v = await getStreakView(userId);
  const msg = formatStreakMessage(v);
  const kb = streakKeyboard(v.checkedInToday);

  // If opened from button, prefer editing the existing message
  // @ts-ignore
  if (ctx.updateType === "callback_query") {
    try {
      // @ts-ignore
      await ctx.editMessageText(msg, { reply_markup: kb });
      return;
    } catch {
      // fall through to sending a new message
    }
  }

  await ctx.reply(msg, { reply_markup: kb });
}

async function doCheckIn(userId: number) {
  const tz = await getTimezoneForUser(userId);
  const todayKey = dateKeyInTz(tz);
  const yesterdayKey = yesterdayKeyFromTodayKey(todayKey);

  const existing = await ReadingStreak.findOne({ userId }).lean();

  // Idempotent: checking in twice does nothing
  if (existing?.lastCheckInDate === todayKey) {
    return;
  }

  const nextStreak =
    existing?.lastCheckInDate === yesterdayKey ? (existing?.currentStreak || 0) + 1 : 1;

  const nextBest = Math.max(existing?.bestStreak || 0, nextStreak);

  await ReadingStreak.findOneAndUpdate(
    { userId },
    {
      $set: {
        lastCheckInDate: todayKey,
        currentStreak: nextStreak,
        bestStreak: nextBest,
      },
    },
    { upsert: true, new: true }
  ).lean();
}

async function resetStreak(userId: number) {
  await ReadingStreak.findOneAndUpdate(
    { userId },
    {
      $set: {
        currentStreak: 0,
        lastCheckInDate: null,
        // bestStreak is preserved intentionally
      },
    },
    { upsert: true, new: true }
  ).lean();
}

// ----------------------------
// Register handlers
// ----------------------------

export function registerReadingStreakHandlers(bot: Telegraf<Context>) {
  // Slash-command entry points (required for your UX)
  bot.command("readingstreak", async (ctx) => {
    if (ctx.from?.id) clearAwaiting(ctx.from.id);
    await openPanel(ctx);
  });

  bot.command("streak", async (ctx) => {
    if (ctx.from?.id) clearAwaiting(ctx.from.id);
    await openPanel(ctx);
  });

  // Button actions
  bot.action("rdstreak:checkin", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      await ctx.answerCbQuery();
    } catch {}

    clearAwaiting(userId);

    try {
      await doCheckIn(userId);
      await openPanel(ctx);
    } catch {
      // Keep failure messages minimal (no noise)
      try {
        await ctx.reply("Check-in failed.");
      } catch {}
    }
  });

  bot.action("rdstreak:reset", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      await ctx.answerCbQuery();
    } catch {}

    setAwaiting(userId, "reset_confirm");

    await ctx.reply(
      "Type RESET to confirm resetting your current streak.\nType anything else to cancel."
    );
  });

  bot.action("rdstreak:close", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) clearAwaiting(userId);

    try {
      await ctx.answerCbQuery();
    } catch {}

    // Try to delete; if not possible, edit to "Closed."
    try {
      // @ts-ignore
      await ctx.deleteMessage();
    } catch {
      try {
        // @ts-ignore
        await ctx.editMessageText("Closed.");
      } catch {}
    }
  });

  // Typed confirmation handler (button -> user types)
  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const a = getAwaiting(userId);
    if (!a) return next();

    const text = String(ctx.message.text || "").trim();

    if (a.kind === "reset_confirm") {
      if (text.toUpperCase() === "RESET") {
        clearAwaiting(userId);
        await resetStreak(userId);
        await ctx.reply("Your current streak has been reset.");
        await openPanel(ctx);
      } else {
        clearAwaiting(userId);
        await ctx.reply("Canceled.");
        await openPanel(ctx);
      }
      return;
    }

    return next();
  });
}