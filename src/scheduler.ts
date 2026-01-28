// src/scheduler.ts

import { Telegraf, Markup } from "telegraf";
import mongoose from "mongoose";
import { DateTime } from "luxon";

import { Reminder, ReminderDoc } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function makeInstanceId(prefix = "sched") {
  return `${prefix}_${process.pid}_${Date.now()}`;
}

type SchedulerOptions = {
  // Preferred name
  pollEveryMs?: number;

  // Backwards-compatible alias (in case some other file still uses it)
  pollIntervalMs?: number;

  // Lock TTL (preferred)
  lockTtlMs?: number;

  // Backwards-compatible/alternate lock settings
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
 * - Acquire a lock on a reminder so only one instance processes it.
 * - Works across multiple Render deploys/instances.
 */
async function acquireLock(reminderId: any, instanceId: string, lockSeconds: number) {
  const lockedAt = now();
  const lockExpiresAt = addSeconds(lockedAt, lockSeconds);

  const res = await Reminder.updateOne(
    {
      _id: reminderId,
      status: "scheduled",
      $or: [
        { "lock.lockExpiresAt": { $exists: false } },
        { "lock.lockExpiresAt": { $lte: lockedAt } }
      ]
    },
    {
      $set: {
        "lock.lockedAt": lockedAt,
        "lock.lockExpiresAt": lockExpiresAt,
        "lock.lockedBy": instanceId
      }
    }
  );

  return res.modifiedCount === 1;
}

/**
 * - Release lock safely using $unset (cleaner than setting undefined).
 */
async function releaseLock(reminderId: any, instanceId: string) {
  await Reminder.updateOne(
    { _id: reminderId, "lock.lockedBy": instanceId },
    {
      $unset: {
        "lock.lockedAt": 1,
        "lock.lockExpiresAt": 1,
        "lock.lockedBy": 1
      }
    }
  );
}

/**
 * Convert a stored "HH:mm" into hour/minute numbers.
 */
function parseTimeOfDay(timeOfDay?: string): { hour: number; minute: number } | null {
  if (!timeOfDay) return null;
  const t = String(timeOfDay).trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  const [hh, mm] = t.split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hour: hh, minute: mm };
}

/**
 * Timezone-accurate next-run computation for repeating reminders.
 * - interval: now + intervalMinutes
 * - daily: next day at schedule.timeOfDay (or keep same time as current nextRunAt)
 * - weekly: next occurrence of schedule.daysOfWeek at schedule.timeOfDay
 */
function computeNextForRepeatLuxon(rem: any): Date | null {
  const sched = rem.schedule;
  if (!sched || !sched.kind || sched.kind === "once") return null;

  const tz = String(rem.timezone || "America/Chicago");
  const nowZ = DateTime.now().setZone(tz);

  // -------------------------
  // interval: now + X minutes
  // -------------------------
  if (sched.kind === "interval") {
    const mins = Number(sched.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return nowZ.plus({ minutes: mins }).toJSDate();
  }

  // -----------------------------------------
  // Pick time-of-day (HH:mm), timezone-correct
  // -----------------------------------------
  const timeFromSchedule = parseTimeOfDay(sched.timeOfDay);

  const timeFromNext = rem.nextRunAt
    ? DateTime.fromJSDate(rem.nextRunAt, { zone: tz })
    : null;

  const hour =
    timeFromSchedule?.hour ??
    (timeFromNext?.isValid ? timeFromNext.hour : 9);

  const minute =
    timeFromSchedule?.minute ??
    (timeFromNext?.isValid ? timeFromNext.minute : 0);

  // -------------------------
  // daily
  // -------------------------
  if (sched.kind === "daily") {
  const step = Math.max(1, Number(sched.interval || 1));
  let candidate = nowZ.set({ hour, minute, second: 0, millisecond: 0 });
  while (candidate <= nowZ) candidate = candidate.plus({ days: step });
  return candidate.toJSDate();
}

  // -------------------------
  // weekly
  // daysOfWeek: Sun=0..Sat=6
  // Luxon weekday: Mon=1..Sun=7
  // -------------------------
  if (sched.kind === "weekly") {
    const days: number[] = Array.isArray(sched.daysOfWeek) ? sched.daysOfWeek : [];

    const targetLuxonWeekdays = new Set(
      days
        .map((d) => Number(d))
        .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
        .map((d) => (d === 0 ? 7 : d)) // Sun 0 -> 7
    );

    // If none provided, default to today's weekday
    if (targetLuxonWeekdays.size === 0) {
      targetLuxonWeekdays.add(nowZ.weekday);
    }

    // Search next 7 days for next valid day at HH:mm
    for (let i = 0; i <= 7; i++) {
      const day = nowZ.plus({ days: i });
      if (!targetLuxonWeekdays.has(day.weekday)) continue;

      const candidate = day.set({ hour, minute, second: 0, millisecond: 0 });
      if (candidate > nowZ) return candidate.toJSDate();
    }

    // fallback
    return nowZ.plus({ days: 7 }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
  }

  // -------------------------
  // monthly
  // supports: interval + anchorDayOfMonth
  // (clamps to last day of month if needed)
  // -------------------------
  if (sched.kind === "monthly") {
    const step = Math.max(1, Number(sched.interval || 1));

    const anchorDay =
      Number(sched.anchorDayOfMonth) ||
      (timeFromNext?.isValid ? timeFromNext.day : nowZ.day);

    const clampDay = (dt: DateTime, dayNum: number) => {
      if (!dt.isValid) return dt;
      const dim = dt.daysInMonth ?? 31;
      const safeDay = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safeDay });
    };

    let candidate = clampDay(
      nowZ.set({ hour, minute, second: 0, millisecond: 0 }),
      anchorDay
    );

    while (candidate <= nowZ) {
      candidate = clampDay(candidate.plus({ months: step }), anchorDay);
    }

    return candidate.toJSDate();
  }

  // -------------------------
  // yearly
  // supports: interval + anchorMonth + anchorDay
  // (clamps for Feb 29, etc.)
  // -------------------------
  if (sched.kind === "yearly") {
    const step = Math.max(1, Number(sched.interval || 1));

    const anchorMonth =
      Number(sched.anchorMonth) ||
      (timeFromNext?.isValid ? timeFromNext.month : nowZ.month);

    const anchorDay =
      Number(sched.anchorDay) ||
      (timeFromNext?.isValid ? timeFromNext.day : nowZ.day);

    const clampDay = (dt: DateTime, dayNum: number) => {
      if (!dt.isValid) return dt;
      const dim = dt.daysInMonth ?? 31;
      const safeDay = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safeDay });
    };

    let candidate = nowZ.set({
      month: Math.min(Math.max(1, anchorMonth), 12),
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });

    candidate = clampDay(candidate, anchorDay);

    while (candidate <= nowZ) {
      candidate = clampDay(candidate.plus({ years: step }), anchorDay);
    }

    return candidate.toJSDate();
  }

  return null;
}

/**
 * Back-compat repeat computation (kept, but we prefer Luxon version now).
 * (Still used as fallback if Luxon can't compute for some reason.)
 *
 * IMPORTANT: This fallback must NOT do +24h/+7d in minutes (DST drift).
 * So it uses Luxon anchored to rem.nextRunAt in the reminder's timezone.
 */
function computeNextForRepeat(rem: ReminderDoc | any): Date | null {
  const sched = rem.schedule;
  if (!sched || !sched.kind || sched.kind === "once") return null;

  // Interval fallback is fine (absolute minutes)
  if (sched.kind === "interval") {
    const mins = Number(sched.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return addMinutes(now(), mins);
  }

  if (!rem.nextRunAt) return null;

  const tz = String(rem.timezone || "America/Chicago");
  const base = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
  if (!base.isValid) return null;

  if (sched.kind === "daily") return base.plus({ days: 1 }).toJSDate();
  if (sched.kind === "weekly") return base.plus({ weeks: 1 }).toJSDate();

  // For monthly/yearly, Luxon version above should handle it; keep null here as a true fallback.
  return null;
}

/**
 * Build inline buttons for the reminder DM message.
 */
function reminderActionKeyboard(reminderId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Done", `rs:done:${reminderId}`),
      Markup.button.callback("Snooze 15m", `rs:sz:${reminderId}:15`),
      Markup.button.callback("Snooze 1h", `rs:sz:${reminderId}:60`)
    ]
  ]);
}

/**
 * - SEND: important part for custom emojis + bold/italics/etc
 * - Telegram renders formatting ONLY if it has message entities.
 * - We store entities on the reminder document and replay them here.
 */
async function sendReminder(bot: Telegraf<any>, rem: any) {
  const text = String(rem.text ?? "");

  const entities =
    Array.isArray(rem.entities) && rem.entities.length > 0 ? rem.entities : undefined;

  const sendOpts: any = {};

  if (entities) {
    sendOpts.entities = entities;
  }

  // Add inline buttons (Done / Snooze)
  sendOpts.reply_markup = reminderActionKeyboard(String(rem._id)).reply_markup;

  try {
    await bot.telegram.sendMessage(rem.chatId, text, sendOpts);
  } catch (err: any) {
    console.error(`Failed to send reminder ${rem._id} to chat ${rem.chatId}:`, err.message);
    throw err;
  }
}

// Ensure we don't register handlers multiple times.
let actionsRegistered = false;

function registerReminderActionHandlers(bot: Telegraf<any>) {
  if (actionsRegistered) return;
  actionsRegistered = true;

  bot.action(/^rs:/, async (ctx) => {
    const data = (ctx.callbackQuery as any)?.data as string;
    const userId = ctx.from?.id;

    await ctx.answerCbQuery().catch(() => {});

    if (!userId || !data) return;

    const parts = data.split(":");

    // rs:done:<id>
    if (parts[1] === "done") {
      const id = parts[2];
      if (!id) return;

      const rem = await Reminder.findOne({ _id: id, userId }).lean();
      if (!rem) {
        await ctx.reply("That reminder no longer exists.");
        return;
      }

      const tz = String(rem.timezone || "America/Chicago");
      const kind = rem.schedule?.kind || "once";

      // If repeating, advance to next occurrence and keep it scheduled
      if (kind !== "once") {
        const nextLuxon = computeNextForRepeatLuxon(rem);
        const nextFallback = nextLuxon ? null : computeNextForRepeat(rem as any);
        const nextRunAt = nextLuxon || nextFallback;

        if (nextRunAt) {
          await Reminder.updateOne(
            { _id: id, userId },
            {
              $set: {
                status: "scheduled",
                lastRunAt: new Date(),
                nextRunAt
              }
            }
          );

          const nextStr = DateTime.fromJSDate(nextRunAt, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
          await ctx.reply(`Marked done. Next reminder: ${nextStr}`);
          return;
        }

        // If for some reason we can't compute next, just mark sent.
        await Reminder.updateOne(
          { _id: id, userId },
          { $set: { status: "sent", lastRunAt: new Date() } }
        );
        await ctx.reply("Marked done.");
        return;
      }

      // Once: just mark sent
      await Reminder.updateOne(
        { _id: id, userId },
        { $set: { status: "sent", lastRunAt: new Date() } }
      );
      await ctx.reply("Marked done.");
      return;
    }

    // rs:sz:<id>:<minutes>
    if (parts[1] === "sz") {
      const id = parts[2];
      const minutes = Number(parts[3]);

      if (!id || !Number.isFinite(minutes) || minutes <= 0) return;

      const rem = await Reminder.findOne({ _id: id, userId }).lean();
      if (!rem) {
        await ctx.reply("That reminder no longer exists.");
        return;
      }

      const newTime = new Date(Date.now() + minutes * 60 * 1000);

      await Reminder.updateOne(
        { _id: id, userId },
        { $set: { nextRunAt: newTime, status: "scheduled" } }
      );

      const tz = String(rem.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next reminder: ${nextStr}`);
      return;
    }
  });
}

export function startScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  // register callback buttons handler (Done/Snooze)
  registerReminderActionHandlers(bot);

  const pollEveryMs = opts.pollEveryMs ?? opts.pollIntervalMs ?? 10_000;

  // lockSeconds priority:
  // 1) explicit lockSeconds
  // 2) lockTtlMs converted to seconds
  // 3) default 60s
  const lockSeconds =
    typeof opts.lockSeconds === "number" && opts.lockSeconds > 0
      ? Math.floor(opts.lockSeconds)
      : typeof opts.lockTtlMs === "number" && opts.lockTtlMs > 0
        ? Math.max(5, Math.floor(opts.lockTtlMs / 1000))
        : 60;

  const instanceId = opts.instanceId ?? makeInstanceId();

  console.log(`Scheduler started (${instanceId}). Poll every ${pollEveryMs}ms`);

  const tick = async () => {
    try {
      if (mongoose.connection.readyState !== 1) return;

      const due = await Reminder.find({
        status: "scheduled",
        nextRunAt: { $lte: now() }
      })
        .sort({ nextRunAt: 1 })
        .limit(25);

      for (const rem of due) {
        const got = await acquireLock(rem._id, instanceId, lockSeconds);
        if (!got) continue;

        try {
          await sendReminder(bot, rem);

          // Prefer Luxon recurrence (timezone-accurate)
          const nextForRepeatLuxon = computeNextForRepeatLuxon(rem);
          const nextForRepeatFallback = nextForRepeatLuxon ? null : computeNextForRepeat(rem);
          const nextForRepeat = nextForRepeatLuxon || nextForRepeatFallback;

          if (rem.schedule && rem.schedule.kind !== "once" && nextForRepeat) {
            await Reminder.updateOne(
              { _id: rem._id },
              {
                $set: {
                  nextRunAt: nextForRepeat,
                  lastRunAt: now(),
                  status: "scheduled"
                }
              }
            );
          } else {
            await Reminder.updateOne(
              { _id: rem._id },
              {
                $set: { lastRunAt: now(), status: "sent" }
              }
            );
          }
        } catch (err) {
          console.error("Scheduler send error:", err);

          // If send fails, push it out 5 minutes so it doesn't hammer.
          await Reminder.updateOne(
            { _id: rem._id },
            { $set: { nextRunAt: addMinutes(now(), 5) } }
          );
        } finally {
          await releaseLock(rem._id, instanceId);
        }
      }
    } catch (err) {
      console.error("Scheduler tick error:", err);
    }
  };

  // fire once quickly
  tick().catch(() => {});

  const handle = setInterval(() => {
    tick().catch(() => {});
  }, pollEveryMs);

  return () => clearInterval(handle);
}