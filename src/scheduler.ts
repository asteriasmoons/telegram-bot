import { Telegraf } from "telegraf";
import mongoose from "mongoose";
import { Reminder, ReminderDoc } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function makeInstanceId(prefix = "sched") {
  return `${prefix}_${process.pid}_${Date.now()}`;
}

type SchedulerOptions = {
  pollEveryMs?: number;
  instanceId?: string;
};

function now() {
  return new Date();
}

function addSeconds(d: Date, seconds: number) {
  return new Date(d.getTime() + seconds * 1000);
}

async function acquireLock(reminderId: any, instanceId: string, lockSeconds = 30) {
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

async function releaseLock(reminderId: any, instanceId: string) {
  await Reminder.updateOne(
    { _id: reminderId, "lock.lockedBy": instanceId },
    {
      $set: {
        "lock.lockedAt": undefined,
        "lock.lockExpiresAt": undefined,
        "lock.lockedBy": undefined
      }
    }
  );
}

function computeNextForRepeat(rem: ReminderDoc): Date | null {
  const sched = rem.schedule;
  if (!sched) return null;

  if (sched.kind === "interval") {
    const mins = sched.intervalMinutes;
    if (!mins || mins <= 0) return null;
    return addMinutes(now(), mins);
  }

  // For daily/weekly we rely on nextRunAt being set by your creation flow.
  // After sending, we compute the next occurrence in the user's timezone.
  // Minimal approach: add 1 day or 7 days from last run, keeping local time.
  // If you want stricter TZ handling later, we can upgrade it.
  if (sched.kind === "daily") return addMinutes(rem.nextRunAt, 24 * 60);
  if (sched.kind === "weekly") return addMinutes(rem.nextRunAt, 7 * 24 * 60);

  return null;
}

export function startScheduler(bot: Telegraf<any>, opts: SchedulerOptions = {}) {
  const pollEveryMs = opts.pollEveryMs ?? 10_000;
  const instanceId = opts.instanceId ?? makeInstanceId();

  console.log(`Scheduler started (${instanceId}). Poll every ${pollEveryMs}ms`);

  const tick = async () => {
    try {
      // If Mongo is disconnected, don't spam errors
      if (mongoose.connection.readyState !== 1) return;

      const due = await Reminder.find({
        status: "scheduled",
        nextRunAt: { $lte: now() }
      })
        .sort({ nextRunAt: 1 })
        .limit(25);

      for (const rem of due) {
        const got = await acquireLock(rem._id, instanceId);
        if (!got) continue;

        try {
          // SEND with entities (this is the custom emoji preservation)
          const sendOpts: any = {};
          if (Array.isArray((rem as any).entities) && (rem as any).entities.length > 0) {
            sendOpts.entities = (rem as any).entities;
          }

          await bot.telegram.sendMessage(rem.chatId, rem.text, sendOpts);

          const nextForRepeat = computeNextForRepeat(rem);

          if (rem.schedule && rem.schedule.kind !== "once" && nextForRepeat) {
            await Reminder.updateOne(
              { _id: rem._id },
              {
                $set: { nextRunAt: nextForRepeat, lastRunAt: now(), status: "scheduled" }
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
          // If send fails, reschedule 5 minutes later so it doesn't hammer
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