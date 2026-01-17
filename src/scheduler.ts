import { Telegraf } from "telegraf";
import { DateTime } from "luxon";
import { Reminder } from "./models/Reminder";

type SchedulerOptions = {
  pollIntervalMs?: number;  // default 10s
  lockTtlMs?: number;       // default 60s
  instanceId?: string;      // default random-ish
};

function makeInstanceId() {
  return `sched_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function computeNextFromSchedule(params: {
  timezone: string;
  scheduleKind: "once" | "daily" | "weekly" | "interval";
  timeOfDay?: string;          // "HH:MM"
  daysOfWeek?: number[];       // 0-6 Sun-Sat
  intervalMinutes?: number;
  base: Date;                  // usually "now" or last nextRunAt
}): Date | null {
  const { timezone, scheduleKind, timeOfDay, daysOfWeek, intervalMinutes, base } = params;

  if (scheduleKind === "once") return null;

  if (scheduleKind === "interval") {
    if (!intervalMinutes || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
    return addMinutes(base, intervalMinutes);
  }

  // For daily/weekly we use timeOfDay in the reminder's timezone.
  const zone = timezone || "America/Chicago";
  const now = DateTime.fromJSDate(base, { zone });

  const hhmm = (timeOfDay && /^\d{2}:\d{2}$/.test(timeOfDay)) ? timeOfDay : "09:00";
  const [hh, mm] = hhmm.split(":").map((x) => Number(x));

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  if (scheduleKind === "daily") {
    let candidate = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (candidate <= now) candidate = candidate.plus({ days: 1 });
    return candidate.toJSDate();
  }

  // weekly
  const dows = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? Array.from(new Set(daysOfWeek)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
    : [now.weekday % 7]; // default: same weekday as now (Sun=0..Sat=6)

  // Find next occurrence among the allowed days
  // Luxon weekday: Mon=1..Sun=7; we want Sun=0..Sat=6
  const currentDow = now.weekday % 7;

  for (let offset = 0; offset <= 7; offset++) {
    const check = now.plus({ days: offset });
    const dow = check.weekday % 7;
    if (!dows.includes(dow)) continue;

    const candidate = check.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (candidate > now) return candidate.toJSDate();
  }

  // Fallback: one week later on first allowed day
  const fallback = now.plus({ days: 7 }).set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  return fallback.toJSDate();
}

async function tryLockOne(instanceId: string, lockTtlMs: number) {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + lockTtlMs);

  // Lock rules:
  // - only scheduled reminders
  // - due now
  // - lock is missing OR expired
  const doc = await Reminder.findOneAndUpdate(
    {
      status: "scheduled",
      nextRunAt: { $lte: now },
      $or: [
        { "lock.lockExpiresAt": { $exists: false } },
        { "lock.lockExpiresAt": { $lte: now } }
      ]
    },
    {
      $set: {
        "lock.lockedAt": now,
        "lock.lockExpiresAt": lockExpiresAt,
        "lock.lockedBy": instanceId
      }
    },
    { sort: { nextRunAt: 1 }, new: true }
  );

  return doc;
}

export function createScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const lockTtlMs = opts.lockTtlMs ?? 60_000;
  const instanceId = opts.instanceId ?? makeInstanceId();

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;

    try {
      // Process up to 10 due reminders per tick
      for (let i = 0; i < 10; i++) {
        const reminder = await tryLockOne(instanceId, lockTtlMs);
        if (!reminder) break;

        try {
          // Send DM to the chatId stored on the reminder
          await bot.telegram.sendMessage(reminder.chatId, reminder.text, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Done", callback_data: `r:done:${String(reminder._id)}` },
                  { text: "Snooze 10m", callback_data: `r:snooze:10:${String(reminder._id)}` },
                  { text: "Snooze 1h", callback_data: `r:snooze:60:${String(reminder._id)}` }
                ],
                [{ text: "Delete", callback_data: `r:del:${String(reminder._id)}` }]
              ]
            }
          });

          const scheduleKind = reminder.schedule?.kind ?? "once";
          const timezone = reminder.timezone || "America/Chicago";

          // Mark last run time
          const now = new Date();

          if (scheduleKind === "once") {
            await Reminder.updateOne(
              { _id: reminder._id, "lock.lockedBy": instanceId },
              {
                $set: {
                  status: "sent",
                  lastRunAt: now,
                  "lock.lockExpiresAt": now
                }
              }
            );
            continue;
          }

          const next = computeNextFromSchedule({
            timezone,
            scheduleKind,
            timeOfDay: reminder.schedule?.timeOfDay,
            daysOfWeek: reminder.schedule?.daysOfWeek,
            intervalMinutes: reminder.schedule?.intervalMinutes, // ✅ correct location
            base: now
          });

          if (!next) {
            // If repeating schedule is broken, pause it (your schema supports paused)
            await Reminder.updateOne(
              { _id: reminder._id, "lock.lockedBy": instanceId },
              {
                $set: {
                  status: "paused",
                  lastRunAt: now,
                  "lock.lockExpiresAt": now
                }
              }
            );
            continue;
          }

          await Reminder.updateOne(
            { _id: reminder._id, "lock.lockedBy": instanceId },
            {
              $set: {
                status: "scheduled",
                nextRunAt: next,
                lastRunAt: now,
                "lock.lockExpiresAt": now
              }
            }
          );
        } catch (err) {
          console.error("Scheduler send/handle error:", err);

          // Release the lock fast so it doesn't stall forever
          const now = new Date();
          await Reminder.updateOne(
            { _id: reminder._id, "lock.lockedBy": instanceId },
            { $set: { "lock.lockExpiresAt": now } }
          );
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      console.log(`Scheduler started (${instanceId}). Poll every ${pollIntervalMs}ms`);
      tick().catch(() => {});
      timer = setInterval(() => tick().catch(() => {}), pollIntervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log("Scheduler stopped");
    }
  };
}

// Convenience helper in case your index calls a simple function.
export function startScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  const s = createScheduler(bot, opts);
  s.start();
  return s;
}