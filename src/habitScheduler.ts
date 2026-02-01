// src/habitScheduler.ts
import type { Telegraf } from "telegraf";
import { Markup } from "telegraf";
import mongoose from "mongoose";
import { DateTime } from "luxon";

import { Habit } from "./models/Habit";
import { HabitLog } from "./models/HabitLog";
import { addMinutes } from "./utils/time";

export function makeInstanceId(prefix = "habitsched") {
  return `${prefix}_${process.pid}_${Date.now()}`;
}

type SchedulerOptions = {
  pollEveryMs?: number;
  pollIntervalMs?: number;
  lockTtlMs?: number;
  lockSeconds?: number;
  instanceId?: string;
};

function now() {
  return new Date();
}

function addSeconds(d: Date, seconds: number) {
  return new Date(d.getTime() + seconds * 1000);
}

function computeNextWeeklyFromStartAt(h: any): Date | null {
  if (!h.startAt) return null;

  const tz = String(h.timezone || "America/Chicago");
  const nowZ = DateTime.now().setZone(tz);

  const startZ = DateTime.fromJSDate(new Date(h.startAt), { zone: tz });
  if (!startZ.isValid) return null;

  // If start is still in the future, that's the next reminder
  if (nowZ < startZ) return startZ.toJSDate();

  // How many whole weeks have passed since start?
  const weeks = Math.floor(nowZ.diff(startZ, "weeks").weeks);

  // Candidate: start + (weeks * 7d)
  const candidate = startZ.plus({ weeks });

  // If candidate is still ahead (rare), use it; otherwise next week
  const next = candidate > nowZ ? candidate : startZ.plus({ weeks: weeks + 1 });

  return next.toJSDate();
}

/**
 * Acquire lock on a habit so only one instance processes it.
 * NOTE: Your Habit schema must include `lock.lockExpiresAt/lockedAt/lockedBy`.
 */
async function acquireLock(habitId: any, instanceId: string, lockSeconds: number) {
  const lockedAt = now();
  const lockExpiresAt = addSeconds(lockedAt, lockSeconds);

  const res = await Habit.updateOne(
    {
      _id: habitId,
      status: "active",
      $or: [{ "lock.lockExpiresAt": { $exists: false } }, { "lock.lockExpiresAt": { $lte: lockedAt } }],
    },
    {
      $set: {
        "lock.lockedAt": lockedAt,
        "lock.lockExpiresAt": lockExpiresAt,
        "lock.lockedBy": instanceId,
      },
    }
  );

  return res.modifiedCount === 1;
}

async function releaseLock(habitId: any, instanceId: string) {
  await Habit.updateOne(
    { _id: habitId, "lock.lockedBy": instanceId },
    {
      $unset: {
        "lock.lockedAt": 1,
        "lock.lockExpiresAt": 1,
        "lock.lockedBy": 1,
      },
    }
  );
}

function parseTimeOfDay(timeOfDay?: string): { hour: number; minute: number } | null {
  if (!timeOfDay) return null;
  const t = String(timeOfDay).trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return null;

  const [hh, mm] = t.split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  return { hour: hh, minute: mm };
}

function nextAtTime(nowZ: DateTime, hhmm: string): DateTime | null {
  const t = parseTimeOfDay(hhmm);
  if (!t) return null;
  return nowZ.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
}

/**
 * Habits reminder schedule (MATCHES your Habit.ts model):
 * - kind: "off" => null
 * - kind: "times" => timesOfDay (array HH:mm)
 * - kind: "hourly" => everyHours within optional windowStart/windowEnd
 * - kind: "every_x_minutes" => everyMinutes within optional windowStart/windowEnd
 */
function computeNextForHabitLuxon(h: any): Date | null {
  const tz = String(h.timezone || "America/Chicago");
  const nowZ = DateTime.now().setZone(tz);

  // ✅ Weekly cadence uses anchor datetime (startAt)
  // This MUST run before the "kind === off" return,
  // because weekly does not rely on reminderSchedule.kind.
  if (String(h.cadence) === "weekly") {
    const weeklyNext = computeNextWeeklyFromStartAt(h);
    if (weeklyNext) return weeklyNext;

    // Weekly but missing startAt → fallback so it still runs
    return nowZ.plus({ weeks: 1 }).toJSDate();
  }

  // Everything below is for non-weekly cadence using reminderSchedule.kind
  const sched = h.reminderSchedule;
  if (!sched || !sched.kind || sched.kind === "off") return null;

  function getWindow() {
    const ws = String(sched.windowStart || "").trim();
    const we = String(sched.windowEnd || "").trim();
    const wStart = parseTimeOfDay(ws);
    const wEnd = parseTimeOfDay(we);
    if (!wStart || !wEnd) return null;

    const startToday = nowZ.set({ hour: wStart.hour, minute: wStart.minute, second: 0, millisecond: 0 });
    const endToday = nowZ.set({ hour: wEnd.hour, minute: wEnd.minute, second: 0, millisecond: 0 });

    if (endToday <= startToday) return null;
    return { startToday, endToday };
  }

  if (sched.kind === "times") {
    const times: string[] = Array.isArray(sched.timesOfDay) ? sched.timesOfDay : [];
    const parsed = times
      .map((t) => String(t || "").trim())
      .filter((t) => /^\d{2}:\d{2}$/.test(t))
      .sort();

    if (parsed.length === 0) return null;

    for (const t of parsed) {
      const cand = nextAtTime(nowZ, t);
      if (cand && cand > nowZ) return cand.toJSDate();
    }

    const tomorrow = nowZ.plus({ days: 1 }).startOf("day");
    const first = nextAtTime(tomorrow, parsed[0]);
    return (first ?? tomorrow.plus({ hours: 9 })).toJSDate();
  }

  if (sched.kind === "hourly") {
    const everyHours = Number(sched.everyHours);
    if (!Number.isFinite(everyHours) || everyHours <= 0) return null;

    const win = getWindow();
    if (!win) return nowZ.plus({ hours: everyHours }).toJSDate();

    const { startToday, endToday } = win;

    if (nowZ < startToday) return startToday.toJSDate();
    if (nowZ >= endToday) return startToday.plus({ days: 1 }).toJSDate();

    const next = nowZ.plus({ hours: everyHours });
    if (next < endToday) return next.toJSDate();

    return startToday.plus({ days: 1 }).toJSDate();
  }

  if (sched.kind === "every_x_minutes") {
    const everyMinutes = Number(sched.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return null;

    const win = getWindow();
    if (!win) return nowZ.plus({ minutes: everyMinutes }).toJSDate();

    const { startToday, endToday } = win;

    if (nowZ < startToday) return startToday.toJSDate();
    if (nowZ >= endToday) return startToday.plus({ days: 1 }).toJSDate();

    const next = nowZ.plus({ minutes: everyMinutes });
    if (next < endToday) return next.toJSDate();

    return startToday.plus({ days: 1 }).toJSDate();
  }

  return null;
}

/**
 * Habit reminder buttons
 */
function habitActionKeyboard(habitId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Log", `hb:log:${habitId}`),
      Markup.button.callback("Snooze 15m", `hb:sz:${habitId}:15`),
      Markup.button.callback("Custom", `hb:szc:${habitId}`),
    ],
  ]);
}

async function sendHabitReminder(bot: Telegraf<any>, h: any) {
  const habitName = String(h.name ?? "Habit");
  const unit = String(h.unit ?? "");
  const amount = Number(h.targetAmount ?? 0);
  const targetCount = Number(h.targetCount ?? 1);
  const cadence = String(h.cadence ?? "daily");

  const targetLine =
    amount > 0 && unit
      ? `Target: ${targetCount} × ${amount} ${unit} (${cadence})`
      : `Target: ${targetCount} session${targetCount === 1 ? "" : "s"} (${cadence})`;

  const text = `Habit: ${habitName}\n${targetLine}\nTap Log when you complete a session.`;

  const chatId = Number(h.chatId ?? h.userId);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new Error("Habit is missing chatId/userId");
  }

  await bot.telegram.sendMessage(chatId, text, habitActionKeyboard(String(h._id)));
}

// In-memory pending flows
const pendingHabitCustomSnooze = new Map<number, { habitId: string; expiresAt: number; promptMessageId?: number }>();
const pendingHabitLog = new Map<number, { habitId: string; expiresAt: number; promptMessageId?: number }>();

function parseDurationToMinutes(input: string): number | null {
  const raw = String(input || "").trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([mhd])?$/);
  if (!m) return null;

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (m[2] || "m") as "m" | "h" | "d";
  const minutes = unit === "m" ? value : unit === "h" ? value * 60 : value * 1440;

  const rounded = Math.round(minutes);
  return rounded > 0 ? rounded : null;
}

function parseNumber(input: string): number | null {
  const raw = String(input || "").trim().replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Ensure we only install handlers once
let habitFlowsInstalled = false;

/**
 * Install the interactive habit flows (button clicks + capturing the typed reply).
 * CALL THIS ONCE right after createBot(token), BEFORE any other "text" handlers.
 */
export function installHabitFlows(bot: Telegraf<any>) {
  if (habitFlowsInstalled) return;
  habitFlowsInstalled = true;

  // 1) Button clicks
  bot.action(/^hb:/, async (ctx) => {
    const data = (ctx.callbackQuery as any)?.data as string;
    const userId = ctx.from?.id;

    await ctx.answerCbQuery().catch(() => {});
    if (!userId || !data) return;

    const parts = data.split(":");

    // hb:log:<habitId>
    if (parts[1] === "log") {
      const habitId = parts[2];
      if (!habitId) return;

      const habit = await Habit.findOne({ _id: habitId, userId }).lean();
      if (!habit) {
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const unit = String(habit.unit ?? "");
      const prompt = unit ? `Enter the amount you did (${unit}).` : "Enter the amount you did (number).";

      const sent = await ctx.reply(prompt, Markup.forceReply());

      pendingHabitLog.set(userId, {
        habitId,
        expiresAt: Date.now() + 2 * 60 * 1000,
        promptMessageId: sent.message_id,
      });

      return;
    }

    // hb:szc:<habitId>
    if (parts[1] === "szc") {
      const habitId = parts[2];
      if (!habitId) return;

      const habit = await Habit.findOne({ _id: habitId, userId }).lean();
      if (!habit) {
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const sent = await ctx.reply(
        "Type a snooze duration like:\n- 10m\n- 2h\n- 1d\n(Or just a number for minutes.)",
        Markup.forceReply()
      );

      pendingHabitCustomSnooze.set(userId, {
        habitId,
        expiresAt: Date.now() + 2 * 60 * 1000,
        promptMessageId: sent.message_id,
      });

      return;
    }

    // hb:sz:<habitId>:<minutes>
    if (parts[1] === "sz") {
      const habitId = parts[2];
      const minutes = Number(parts[3]);
      if (!habitId || !Number.isFinite(minutes) || minutes <= 0) return;

      const habit = await Habit.findOne({ _id: habitId, userId }).lean();
      if (!habit) {
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const newTime = new Date(Date.now() + minutes * 60 * 1000);
      await Habit.updateOne({ _id: habitId, userId }, { $set: { nextReminderAt: newTime } });

      const tz = String(habit.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next habit reminder: ${nextStr}`);
      return;
    }
  });

  // 2) Capture typed replies BEFORE other text handlers swallow them
  bot.use(async (ctx, next) => {
    const msg: any = (ctx as any).message;
    const text = msg?.text;
    if (!text) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    const reply = msg?.reply_to_message;
    const replyToId = reply?.message_id;
    const isReplyToBot = !!reply?.from?.is_bot;

    // ---- HABIT LOG FLOW ----
    const pendingLog = pendingHabitLog.get(userId);
    if (pendingLog) {
      if (Date.now() > pendingLog.expiresAt) {
        pendingHabitLog.delete(userId);
        await ctx.reply("Log timed out. Tap Log again if you still want to record a session.");
        return;
      }

      // If Telegram attached reply info, enforce it matches OUR prompt
      if (reply) {
        if (!isReplyToBot) return;
        if (pendingLog.promptMessageId && replyToId !== pendingLog.promptMessageId) return;
      }

      const habit = await Habit.findOne({ _id: pendingLog.habitId, userId }).lean();
      if (!habit) {
        pendingHabitLog.delete(userId);
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const amount = parseNumber(text);
      if (!amount) {
        await ctx.reply("I couldn’t read that number. Try again (like 10 or 1.5).");
        return;
      }

      pendingHabitLog.delete(userId);

      try {
        await HabitLog.create({
          userId,
          habitId: habit._id,
          startedAt: new Date(),
          amount,
          unit: habit.unit,
        });

        await ctx.reply(`Logged: ${amount}${habit.unit ? " " + habit.unit : ""} for "${habit.name}".`);
      } catch (err: any) {
        console.error("HabitLog.create failed:", err);
        await ctx.reply("I couldn't save that log due to a server error. Try again in a moment.");
      }

      return; // consumed
    }

    // ---- CUSTOM SNOOZE FLOW ----
    const pendingSz = pendingHabitCustomSnooze.get(userId);
    if (pendingSz) {
      if (Date.now() > pendingSz.expiresAt) {
        pendingHabitCustomSnooze.delete(userId);
        await ctx.reply("Custom snooze timed out. Tap Custom again if you still want to snooze.");
        return;
      }

      if (reply) {
        if (!isReplyToBot) return;
        if (pendingSz.promptMessageId && replyToId !== pendingSz.promptMessageId) return;
      }

      const minutes = parseDurationToMinutes(text);
      if (!minutes) {
        await ctx.reply("I couldn’t read that. Try something like 10m, 2h, or 1d.");
        return;
      }

      pendingHabitCustomSnooze.delete(userId);

      const habit = await Habit.findOne({ _id: pendingSz.habitId, userId }).lean();
      if (!habit) {
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const newTime = new Date(Date.now() + minutes * 60 * 1000);
      await Habit.updateOne({ _id: pendingSz.habitId, userId }, { $set: { nextReminderAt: newTime } });

      const tz = String(habit.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next habit reminder: ${nextStr}`);
      return;
    }

    return next();
  });
}

export function startHabitScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  const pollEveryMs = opts.pollEveryMs ?? opts.pollIntervalMs ?? 10_000;

  const lockSeconds =
    typeof opts.lockSeconds === "number" && opts.lockSeconds > 0
      ? Math.floor(opts.lockSeconds)
      : typeof opts.lockTtlMs === "number" && opts.lockTtlMs > 0
        ? Math.max(5, Math.floor(opts.lockTtlMs / 1000))
        : 60;

  const instanceId = opts.instanceId ?? makeInstanceId();

  console.log(`Habit Scheduler started (${instanceId}). Poll every ${pollEveryMs}ms`);

  const tick = async () => {
    try {
      if (mongoose.connection.readyState !== 1) return;

      const due = await Habit.find({
        status: "active",
        "reminderSchedule.kind": { $ne: "off" },
        nextReminderAt: { $lte: now() },
      })
        .sort({ nextReminderAt: 1 })
        .limit(25);

      for (const h of due) {
        const got = await acquireLock(h._id, instanceId, lockSeconds);
        if (!got) continue;

        try {
          await sendHabitReminder(bot, h);

          const next = computeNextForHabitLuxon(h);

          if (next) {
            await Habit.updateOne(
              { _id: h._id },
              { $set: { nextReminderAt: next, lastRemindedAt: now() } }
            );
          } else {
            await Habit.updateOne(
              { _id: h._id },
              { $set: { nextReminderAt: undefined, lastRemindedAt: now() } }
            );
          }
        } catch (err) {
          console.error("Habit Scheduler send error:", err);
          await Habit.updateOne({ _id: h._id }, { $set: { nextReminderAt: addMinutes(now(), 5) } });
        } finally {
          await releaseLock(h._id, instanceId);
        }
      }
    } catch (err) {
      console.error("Habit Scheduler tick error:", err);
    }
  };

  tick().catch(() => {});
  const handle = setInterval(() => tick().catch(() => {}), pollEveryMs);
  return () => clearInterval(handle);
}