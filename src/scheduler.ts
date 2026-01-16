import crypto from "crypto";
import { Reminder } from "./models/Reminder";
import { Habit } from "./models/Habit";

type SchedulerOptions = {
  pollIntervalMs: number;
  lockTtlMs: number;
  instanceId: string;
};

function nowDate() {
  return new Date();
}

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

export function createScheduler(opts: SchedulerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let isTickRunning = false;

  async function claimDueReminder() {
    const now = nowDate();
    const lockExpiresAt = addMs(now, opts.lockTtlMs);

    // Claim one due reminder that is not locked (or lock expired)
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
          "lock.lockedBy": opts.instanceId
        }
      },
      { new: true }
    );

    return doc;
  }

  async function claimDueHabit() {
    const now = nowDate();
    const lockExpiresAt = addMs(now, opts.lockTtlMs);

    // Claim one due habit that is active and not locked (or lock expired)
    const doc = await Habit.findOneAndUpdate(
      {
        status: "active",
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
          "lock.lockedBy": opts.instanceId
        }
      },
      { new: true }
    );

    return doc;
  }

  async function processOneReminder() {
    const reminder = await claimDueReminder();
    if (!reminder) return false;

    // Skeleton behavior: log only (no Telegram send yet)
    console.log(
      "[SCHEDULER] Reminder due:",
      String(reminder._id),
      "| userId:",
      reminder.userId,
      "| chatId:",
      reminder.chatId,
      "| text:",
      reminder.text
    );

    const now = nowDate();

    // Skeleton: mark lastRunAt and push nextRunAt forward slightly so you can see progress
    // IMPORTANT: Later we will compute real nextRunAt based on schedule (or mark sent if one-off)
    await Reminder.updateOne(
      { _id: reminder._id, "lock.lockedBy": opts.instanceId },
      {
        $set: {
          lastRunAt: now,
          nextRunAt: addMs(now, 60_000) // +1 minute (temporary skeleton behavior)
        }
      }
    );

    return true;
  }

  async function processOneHabit() {
    const habit = await claimDueHabit();
    if (!habit) return false;

    // Skeleton behavior: log only (no Telegram send yet)
    console.log(
      "[SCHEDULER] Habit ping due:",
      String(habit._id),
      "| userId:",
      habit.userId,
      "| chatId:",
      habit.chatId,
      "| name:",
      habit.name
    );

    const now = nowDate();

    // Skeleton: mark lastRunAt and push nextRunAt forward slightly so you can see progress
    // IMPORTANT: Later we will compute real nextRunAt based on habit.schedule
    await Habit.updateOne(
      { _id: habit._id, "lock.lockedBy": opts.instanceId },
      {
        $set: {
          lastRunAt: now,
          nextRunAt: addMs(now, 60_000) // +1 minute (temporary skeleton behavior)
        }
      }
    );

    return true;
  }

  async function tick() {
    if (isTickRunning) return;
    isTickRunning = true;

    try {
      // Process a few items per tick so we don't starve one collection
      // This is still "skeleton" and can be tuned later.
      let didWork = false;

      // Try up to 5 reminder jobs
      for (let i = 0; i < 5; i++) {
        const worked = await processOneReminder();
        if (!worked) break;
        didWork = true;
      }

      // Try up to 5 habit jobs
      for (let i = 0; i < 5; i++) {
        const worked = await processOneHabit();
        if (!worked) break;
        didWork = true;
      }

      if (!didWork) {
        // Keep logs clean; comment this in if you want heartbeat visibility:
        // console.log("[SCHEDULER] No due jobs.");
      }
    } catch (e) {
      console.error("[SCHEDULER] Tick error:", e);
    } finally {
      isTickRunning = false;
    }
  }

  function start() {
    if (timer) return;
    console.log(
      `[SCHEDULER] Starting. intervalMs=${opts.pollIntervalMs} lockTtlMs=${opts.lockTtlMs} instanceId=${opts.instanceId}`
    );
    timer = setInterval(() => {
      void tick();
    }, opts.pollIntervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    console.log("[SCHEDULER] Stopped.");
  }

  return { start, stop };
}

export function makeInstanceId() {
  return crypto.randomBytes(8).toString("hex");
}