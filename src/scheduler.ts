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
        "lock.lockedBy": 1,
      },
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

function normalizeTimesOfDay(schedule: any): string[] {
  const raw: unknown[] =
    Array.isArray(schedule?.timesOfDay) && schedule.timesOfDay.length
      ? schedule.timesOfDay
      : typeof schedule?.timeOfDay === "string"
        ? [schedule.timeOfDay]
        : [];

  const times = raw
    .map((t) => String(t ?? "").trim())
    .filter((t) => /^\d{2}:\d{2}$/.test(t));

  const uniq = Array.from(new Set(times));
  uniq.sort((a, b) => a.localeCompare(b));
  return uniq;
}

function dateTimeForDayAndTime(dayStart: DateTime, hhmm: string): DateTime | null {
  const parsed = parseTimeOfDay(hhmm);
  if (!parsed) return null;
  return dayStart.set({ hour: parsed.hour, minute: parsed.minute, second: 0, millisecond: 0 });
}

function nextOccurrenceDay(rem: any, tz: string, fromDayStart: DateTime): DateTime | null {
  const sched = rem?.schedule;
  if (!sched || sched.kind === "once" || sched.kind === "interval") return null;

  const kind = sched.kind;
  const from = fromDayStart.setZone(tz).startOf("day");

  if (kind === "daily") {
    const step = Math.max(1, Number(sched.interval || 1));
    return from.plus({ days: step });
  }

  if (kind === "weekly") {
    const days: number[] = Array.isArray(sched.daysOfWeek) ? sched.daysOfWeek : [];
    const target = new Set(
      days
        .map(Number)
        .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
        .map((d) => (d === 0 ? 7 : d)) // Sun(0)->7
    );
    if (target.size === 0) target.add(from.weekday);

    // look forward 1..14 days (covers gaps)
    for (let i = 1; i <= 14; i++) {
      const d = from.plus({ days: i });
      if (target.has(d.weekday)) return d;
    }
    return from.plus({ days: 7 });
  }

  if (kind === "monthly") {
    const step = Math.max(1, Number(sched.interval || 1));

    const desiredDom = Number(sched.dayOfMonth) || from.day;

    const clampDay = (dt: DateTime, dayNum: number) => {
      const dim = dt.daysInMonth ?? 31;
      const safeDay = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safeDay });
    };

    // next month interval from "from"
    const base = from.plus({ months: step }).startOf("month");
    return clampDay(base, desiredDom);
  }

  if (kind === "yearly") {
    const step = Math.max(1, Number(sched.interval || 1));

    const anchorMonth = Number(sched.anchorMonth) || from.month;
    const anchorDay = Number(sched.anchorDay) || from.day;

    const clampDay = (dt: DateTime, dayNum: number) => {
      const dim = dt.daysInMonth ?? 31;
      const safeDay = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safeDay });
    };

    let base = from.plus({ years: step }).set({
      month: Math.min(Math.max(1, anchorMonth), 12),
    });

    base = base.startOf("month");
    base = clampDay(base, anchorDay);

    return base;
  }

  return null;
}

export function computeNextRunAtWithTimes(rem: any, fromDate: Date): Date | null {
  const sched = rem?.schedule;
  if (!sched || sched.kind === "once") return null;

  const tz = String(rem.timezone || "America/Chicago");
  const fromZ = DateTime.fromJSDate(fromDate, { zone: tz });

  if (sched.kind === "interval") {
    const mins = Number(sched.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return fromZ.plus({ minutes: mins }).toJSDate();
  }

  const times = normalizeTimesOfDay(sched);
  if (!times.length) return null;

  // 1) later times today
  const todayStart = fromZ.startOf("day");
  for (const t of times) {
    const cand = dateTimeForDayAndTime(todayStart, t);
    if (cand && cand > fromZ) return cand.toJSDate();
  }

  // 2) day finished -> next occurrence day -> earliest time
  const nextDay = nextOccurrenceDay(rem, tz, todayStart);
  if (!nextDay) return null;

  const first = dateTimeForDayAndTime(nextDay.startOf("day"), times[0]);
  return first ? first.toJSDate() : null;
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

const timeFromNext = rem.nextRunAt ? DateTime.fromJSDate(new Date(rem.nextRunAt), { zone: tz }) : null;

  const hour = timeFromSchedule?.hour ?? (timeFromNext?.isValid ? timeFromNext.hour : 9);
  const minute = timeFromSchedule?.minute ?? (timeFromNext?.isValid ? timeFromNext.minute : 0);

  // -------------------------
  // daily
  // -------------------------
if (sched.kind === "daily") {
  const step = Math.max(1, Number(sched.interval || 1));

  let candidate = nowZ.set({ hour, minute, second: 0, millisecond: 0 });

  // If it's already passed (or equal), move forward by N days until it's future
  while (candidate <= nowZ) {
    candidate = candidate.plus({ days: step });
  }

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
const stepWeeks = Math.max(1, Number(sched.interval || 1));
const maxDays = 7 * stepWeeks;

     for (let i = 0; i <= maxDays; i++) {  
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

const anchorDay = Number(sched.dayOfMonth) || (timeFromNext?.isValid ? timeFromNext.day : nowZ.day);

    const clampDay = (dt: DateTime, dayNum: number) => {
      if (!dt.isValid) return dt;
      const dim = dt.daysInMonth ?? 31;
      const safeDay = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safeDay });
    };

let candidate = clampDay(nowZ.set({ hour, minute, second: 0, millisecond: 0 }), anchorDay);

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

    const anchorMonth = Number(sched.anchorMonth) || (timeFromNext?.isValid ? timeFromNext.month : nowZ.month);
    const anchorDay = Number(sched.anchorDay) || (timeFromNext?.isValid ? timeFromNext.day : nowZ.day);

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

  if (sched.kind === "daily") {
    const step = Math.max(1, Number(sched.interval || 1));
    return base.plus({ days: step }).toJSDate();
  }

  if (sched.kind === "weekly") {
    const step = Math.max(1, Number(sched.interval || 1));
    return base.plus({ weeks: step }).toJSDate();
  }

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
      Markup.button.callback("Custom", `rs:szc:${reminderId}`),
    ],
  ]);
}

/**
 * - SEND: important part for custom emojis + bold/italics/etc
 * - Telegram renders formatting ONLY if it has message entities.
 * - We store entities on the reminder document and replay them here.
 */
async function sendReminder(bot: Telegraf<any>, rem: any) {
  const text = String(rem.text ?? "");

  const entities = Array.isArray(rem.entities) && rem.entities.length > 0 ? rem.entities : undefined;

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

// In-memory pending custom snooze: userId -> { reminderId, expiresAt }
const pendingCustomSnooze = new Map<number, { reminderId: string; expiresAt: number }>();

function parseDurationToMinutes(input: string): number | null {
  const raw = String(input || "").trim().toLowerCase();

  // Allow: "15", "15m", "2h", "1d", "1.5h"
  // Also allow spaced: "15 m", "2 h"
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([mhd])?$/);
  if (!m) return null;

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (m[2] || "m") as "m" | "h" | "d";

  const minutes = unit === "m" ? value : unit === "h" ? value * 60 : value * 1440;

  // clamp + round to whole minutes
  const rounded = Math.round(minutes);
  if (rounded <= 0) return null;

  return rounded;
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
        const nextRunAt = computeNextRunAtWithTimes(rem, new Date());

        if (nextRunAt) {
          await Reminder.updateOne(
            { _id: id, userId },
            {
              $set: {
                status: "scheduled",
                lastRunAt: new Date(),
                nextRunAt,
              },
            }
          );

          const nextStr = DateTime.fromJSDate(nextRunAt, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
          await ctx.reply(`Marked done. Next reminder: ${nextStr}`);
          return;
        }

        // If for some reason we can't compute next, just mark sent.
        await Reminder.updateOne({ _id: id, userId }, { $set: { status: "sent", lastRunAt: new Date() } });
        await ctx.reply("Marked done.");
        return;
      }

      // Once: just mark sent
      await Reminder.updateOne({ _id: id, userId }, { $set: { status: "sent", lastRunAt: new Date() } });
      await ctx.reply("Marked done.");
      return;
    }

    // rs:szc:<id>  (custom snooze prompt)
    if (parts[1] === "szc") {
      const id = parts[2];
      if (!id) return;

      const rem = await Reminder.findOne({ _id: id, userId }).lean();
      if (!rem) {
        await ctx.reply("That reminder no longer exists.");
        return;
      }

      // store pending state for 2 minutes
      pendingCustomSnooze.set(userId, { reminderId: id, expiresAt: Date.now() + 2 * 60 * 1000 });

      await ctx.reply(
        "Type a snooze duration like:\n- 10m\n- 2h\n- 1d\n(You can also just type a number for minutes.)",
        Markup.forceReply()
      );
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

      await Reminder.updateOne({ _id: id, userId }, { $set: { nextRunAt: newTime, status: "scheduled" } });

      const tz = String(rem.timezone || "America/Chicago");
      const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
      await ctx.reply(`Snoozed. Next reminder: ${nextStr}`);
      return;
    }
  });

  // ONE text handler (registered once)
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const pending = pendingCustomSnooze.get(userId);
    if (!pending) return;
    
      const reply = (ctx.message as any)?.reply_to_message;
  if (!reply || !reply.from?.is_bot) {
    return;
  }

  // Optional but recommended: ensure it's replying to *our* prompt
  const repliedText = String(reply.text || "");
  if (!repliedText.includes("Type a snooze duration")) {
    return;
  }

    // Expired pending prompt
    if (Date.now() > pending.expiresAt) {
      pendingCustomSnooze.delete(userId);
      await ctx.reply("Custom snooze timed out. Tap Custom again if you still want to snooze.");
      return;
    }

    const minutes = parseDurationToMinutes((ctx.message as any)?.text);
    if (!minutes) {
      await ctx.reply("I couldn’t read that. Try something like 10m, 2h, or 1d.");
      return;
    }

    // clear pending before DB work (prevents double processing)
    pendingCustomSnooze.delete(userId);

    const rem = await Reminder.findOne({ _id: pending.reminderId, userId }).lean();
    if (!rem) {
      await ctx.reply("That reminder no longer exists.");
      return;
    }

    const newTime = new Date(Date.now() + minutes * 60 * 1000);

    await Reminder.updateOne({ _id: pending.reminderId, userId }, { $set: { nextRunAt: newTime, status: "scheduled" } });

    const tz = String(rem.timezone || "America/Chicago");
    const nextStr = DateTime.fromJSDate(newTime, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a");
    await ctx.reply(`Snoozed. Next reminder: ${nextStr}`);
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
        nextRunAt: { $lte: now() },
      })
        .sort({ nextRunAt: 1 })
        .limit(25);

      for (const rem of due) {
        const got = await acquireLock(rem._id, instanceId, lockSeconds);
        if (!got) continue;

        try {
          await sendReminder(bot, rem);

          // Prefer Luxon recurrence (timezone-accurate)
          const nextForRepeat = computeNextRunAtWithTimes(rem, now());

          if (rem.schedule && rem.schedule.kind !== "once" && nextForRepeat) {
            await Reminder.updateOne(
              { _id: rem._id },
              {
                $set: {
                  nextRunAt: nextForRepeat,
                  lastRunAt: now(),
                  status: "scheduled",
                },
              }
            );
          } else {
            await Reminder.updateOne(
              { _id: rem._id },
              {
                $set: { lastRunAt: now(), status: "sent" },
              }
            );
          }
        } catch (err) {
          console.error("Scheduler send error:", err);

          // If send fails, push it out 5 minutes so it doesn't hammer.
          await Reminder.updateOne({ _id: rem._id }, { $set: { nextRunAt: addMinutes(now(), 5) } });
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