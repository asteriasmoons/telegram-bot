import { Telegraf, Markup } from "telegraf";
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

/**
 * Acquire lock on a habit so only one instance processes it.
 */
async function acquireLock(habitId: any, instanceId: string, lockSeconds: number) {
  const lockedAt = now();
  const lockExpiresAt = addSeconds(lockedAt, lockSeconds);

  const res = await Habit.updateOne(
    {
      _id: habitId,
      status: "scheduled",
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

function fmtHHmm(dt: DateTime) {
  return dt.toFormat("HH:mm");
}

function nextAtTime(nowZ: DateTime, hhmm: string): DateTime | null {
  const t = parseTimeOfDay(hhmm);
  if (!t) return null;
  return nowZ.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
}

/**
 * Habits recurrence:
 * - kind: "times" => schedule.timesOfDay (array HH:mm). Choose next > now, else tomorrow at earliest.
 * - kind: "interval" => everyMinutes within windowStart/windowEnd (HH:mm). Strict required window.
 * - kind: "none" => null (no scheduling)
 *
 * NOTE: Habits reminders are separate from Reminders schedule kinds.
 */
function computeNextForHabitLuxon(h: any): Date | null {
  const sched = h.reminder;
  if (!sched || !sched.kind || sched.kind === "none") return null;

  const tz = String(h.timezone || "America/Chicago");
  const nowZ = DateTime.now().setZone(tz);

  // -------------------------
  // TIMES: pick next time-of-day
  // -------------------------
  if (sched.kind === "times") {
    const times: string[] = Array.isArray(sched.timesOfDay) ? sched.timesOfDay : [];
    const parsed = times
      .map((t) => String(t || "").trim())
      .filter((t) => /^\d{2}:\d{2}$/.test(t))
      .sort(); // HH:mm sorts correctly lexicographically

    if (parsed.length === 0) return null;

    // candidates today
    for (const t of parsed) {
      const cand = nextAtTime(nowZ, t);
      if (cand && cand > nowZ) return cand.toJSDate();
    }

    // otherwise tomorrow earliest time
    const tomorrow = nowZ.plus({ days: 1 }).startOf("day");
    const first = nextAtTime(tomorrow, parsed[0]);
    return (first ?? tomorrow.plus({ hours: 9 })).toJSDate();
  }

  // -------------------------
  // INTERVAL: everyMinutes within a strict window
  // -------------------------
  if (sched.kind === "interval") {
    const every = Number(sched.everyMinutes);
    if (!Number.isFinite(every) || every <= 0) return null;

    const ws = String(sched.windowStart || "").trim();
    const we = String(sched.windowEnd || "").trim();

    const wStart = parseTimeOfDay(ws);
    const wEnd = parseTimeOfDay(we);

    if (!wStart || !wEnd) return null;

    // Build today window boundaries in tz
    const startToday = nowZ.set({ hour: wStart.hour, minute: wStart.minute, second: 0, millisecond: 0 });
    const endToday = nowZ.set({ hour: wEnd.hour, minute: wEnd.minute, second: 0, millisecond: 0 });

    // Require a sensible window: end must be after start (no overnight window for now)
    if (endToday <= startToday) return null;

    // If now before window: next = windowStart today
    if (nowZ < startToday) return startToday.toJSDate();

    // If now after window: next = windowStart tomorrow
    if (nowZ >= endToday) {
      const startTomorrow = startToday.plus({ days: 1 });
      return startTomorrow.toJSDate();
    }

    // Now inside window: next = now + everyMinutes, but if it exceeds end => tomorrow start
    const next = nowZ.plus({ minutes: every });

    if (next < endToday) return next.toJSDate();

    const startTomorrow = startToday.plus({ days: 1 });
    return startTomorrow.toJSDate();
  }

  return null;
}

/**
 * Habit reminder buttons:
 * - Log => prompts for amount (and logs a session)
 * - Snooze 15m
 * - Custom snooze
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
  const amount = Number(h.amountPerSession ?? 0);

  // Keep this message simple + consistent (you can style later)
  const text =
    amount > 0 && unit
      ? `Habit: ${habitName}\nTarget: ${amount} ${unit}\nTap Log when you complete a session.`
      : `Habit: ${habitName}\nTap Log when you complete a session.`;

  const sendOpts: any = {};
  sendOpts.reply_markup = habitActionKeyboard(String(h._id)).reply_markup;

  try {
    await bot.telegram.sendMessage(h.chatId, text, sendOpts);
  } catch (err: any) {
    console.error(`Failed to send habit reminder ${h._id} to chat ${h.chatId}:`, err.message);
    throw err;
  }
}

// In-memory pending custom snooze: userId -> { habitId, expiresAt }
const pendingHabitCustomSnooze = new Map<number, { habitId: string; expiresAt: number }>();

// In-memory pending habit log: userId -> { habitId, expiresAt }
const pendingHabitLog = new Map<number, { habitId: string; expiresAt: number }>();

function parseDurationToMinutes(input: string): number | null {
  const raw = String(input || "").trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([mhd])?$/);
  if (!m) return null;

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (m[2] || "m") as "m" | "h" | "d";
  const minutes = unit === "m" ? value : unit === "h" ? value * 60 : value * 1440;

  const rounded = Math.round(minutes);
  if (rounded <= 0) return null;
  return rounded;
}

function parseNumber(input: string): number | null {
  const raw = String(input || "").trim().replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Ensure we don't register handlers multiple times.
let habitActionsRegistered = false;

function registerHabitActionHandlers(bot: Telegraf<any>) {
  if (habitActionsRegistered) return;
  habitActionsRegistered = true;

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

      // store pending for 2 minutes
      pendingHabitLog.set(userId, { habitId, expiresAt: Date.now() + 2 * 60 * 1000 });

      const unit = String(habit.unit ?? "");
      const prompt =
        unit ? `Enter the amount you did (${unit}).` : "Enter the amount you did (number).";

      await ctx.reply(prompt, Markup.forceReply());
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

      pendingHabitCustomSnooze.set(userId, { habitId, expiresAt: Date.now() + 2 * 60 * 1000 });

      await ctx.reply(
        "Type a snooze duration like:\n- 10m\n- 2h\n- 1d\n(You can also just type a number for minutes.)",
        Markup.forceReply()
      );
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
      await Habit.updateOne({ _id: habitId, userId }, { $set: { nextRunAt: newTime, status: "scheduled" } });

      const tz = String(habit.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next habit reminder: ${nextStr}`);
      return;
    }
  });

  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const reply = (ctx.message as any)?.reply_to_message;
    if (!reply || !reply.from?.is_bot) return;

    const repliedText = String(reply.text || "");

    // --- HABIT LOG FLOW ---
    const pendingLog = pendingHabitLog.get(userId);
    if (pendingLog) {
      if (!repliedText.includes("Enter the amount you did")) return;

      if (Date.now() > pendingLog.expiresAt) {
        pendingHabitLog.delete(userId);
        await ctx.reply("Log timed out. Tap Log again if you still want to record a session.");
        return;
      }

      const habit = await Habit.findOne({ _id: pendingLog.habitId, userId }).lean();
      if (!habit) {
        pendingHabitLog.delete(userId);
        await ctx.reply("That habit no longer exists.");
        return;
      }

      const amount = parseNumber((ctx.message as any)?.text);
      if (!amount) {
        await ctx.reply("I couldn’t read that number. Try again (like 10 or 1.5).");
        return;
      }

      // Clear pending before DB work to prevent double logs
      pendingHabitLog.delete(userId);

      await HabitLog.create({
        userId,
        habitId: habit._id,
        loggedAt: new Date(),
        amount,
        unit: String(habit.unit ?? ""),
      });

      await ctx.reply(`Logged: ${amount}${habit.unit ? " " + habit.unit : ""} for "${habit.name}".`);
      return;
    }

    // --- HABIT CUSTOM SNOOZE FLOW ---
    const pendingSz = pendingHabitCustomSnooze.get(userId);
    if (pendingSz) {
      if (!repliedText.includes("Type a snooze duration")) return;

      if (Date.now() > pendingSz.expiresAt) {
        pendingHabitCustomSnooze.delete(userId);
        await ctx.reply("Custom snooze timed out. Tap Custom again if you still want to snooze.");
        return;
      }

      const minutes = parseDurationToMinutes((ctx.message as any)?.text);
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
      await Habit.updateOne({ _id: pendingSz.habitId, userId }, { $set: { nextRunAt: newTime, status: "scheduled" } });

      const tz = String(habit.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next habit reminder: ${nextStr}`);
      return;
    }
  });
}

export function startHabitScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  registerHabitActionHandlers(bot);

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
        status: "scheduled",
        nextRunAt: { $lte: now() },
      })
        .sort({ nextRunAt: 1 })
        .limit(25);

      for (const h of due) {
        const got = await acquireLock(h._id, instanceId, lockSeconds);
        if (!got) continue;

        try {
          await sendHabitReminder(bot, h);

          // Compute next run strictly via habit rules
          const next = computeNextForHabitLuxon(h);

          if (next) {
            await Habit.updateOne(
              { _id: h._id },
              {
                $set: {
                  nextRunAt: next,
                  lastRunAt: now(),
                  status: "scheduled",
                },
              }
            );
          } else {
            // If it has no scheduling (or can't compute), mark unscheduled
            await Habit.updateOne(
              { _id: h._id },
              {
                $set: { lastRunAt: now(), status: "idle" },
              }
            );
          }
        } catch (err) {
          console.error("Habit Scheduler send error:", err);

          // If send fails, push it out 5 minutes so it doesn't hammer.
          await Habit.updateOne({ _id: h._id }, { $set: { nextRunAt: addMinutes(now(), 5) } });
        } finally {
          await releaseLock(h._id, instanceId);
        }
      }
    } catch (err) {
      console.error("Habit Scheduler tick error:", err);
    }
  };

  tick().catch(() => {});

  const handle = setInterval(() => {
    tick().catch(() => {});
  }, pollEveryMs);

  return () => clearInterval(handle);
}