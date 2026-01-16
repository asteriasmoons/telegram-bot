import crypto from "crypto";
import { DateTime } from "luxon";
import { Reminder } from "./models/Reminder";
import { Habit } from "./models/Habit";
import { addMinutes } from "./utils/time";

type SchedulerOptions = {
  pollIntervalMs: number;
  lockTtlMs: number;
  instanceId: string;

  sendMessage: (chatId: number, text: string, extra?: any) => Promise<any>;
};

function nowDate() {
  return new Date();
}

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

function buildReminderButtons(reminderId: string) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Done", callback_data: `r:done:${reminderId}` },
          { text: "Snooze 10", callback_data: `r:snooze:10:${reminderId}` }
        ],
        [
          { text: "Snooze 60", callback_data: `r:snooze:60:${reminderId}` },
          { text: "Delete", callback_data: `r:del:${reminderId}` }
        ]
      ]
    }
  };
}

function computeNextForSchedule(params: {
  timezone: string;
  schedule: any;
  lastRunAt: Date;
}): Date | null {
  const { timezone, schedule, lastRunAt } = params;

  if (!schedule || !schedule.kind) return null;

  if (schedule.kind === "daily") {
    const timeOfDay = schedule.timeOfDay as string | undefined;
    if (!timeOfDay) return null;

    const [hhStr, mmStr] = timeOfDay.split(":");
    const hh = Number(hhStr);
    const mm = Number(mmStr);

    const next = DateTime.fromJSDate(lastRunAt, { zone: timezone })
      .plus({ days: 1 })
      .set({ hour: hh, minute: mm, second: 0, millisecond: 0 });

    return next.toJSDate();
  }

  if (schedule.kind === "weekly") {
    const timeOfDay = schedule.timeOfDay as string | undefined;
    const daysOfWeek = (schedule.daysOfWeek as number[] | undefined) || [];
    if (!timeOfDay || daysOfWeek.length === 0) return null;

    const [hhStr, mmStr] = timeOfDay.split(":");
    const hh = Number(hhStr);
    const mm = Number(mmStr);

    // daysOfWeek is Sun=0..Sat=6
    const base = DateTime.fromJSDate(lastRunAt, { zone: timezone }).plus({ days: 1 }).startOf("day");

    for (let i = 0; i < 14; i++) {
      const candidate = base.plus({ days: i });
      const dow = candidate.weekday % 7; // Luxon weekday: Mon=1..Sun=7, so %7 makes Sun=0
      if (daysOfWeek.includes(dow)) {
        const withTime = candidate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
        return withTime.toJSDate();
      }
    }

    return null;
  }

  if (schedule.kind === "interval") {
    const intervalMinutes = Number(schedule.intervalMinutes || 0);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
    return addMinutes(lastRunAt, intervalMinutes);
  }

  return null;
}

export function createScheduler(opts: SchedulerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let isTickRunning = false;

  async function claimDueReminder() {
    const now = nowDate();
    const lockExpiresAt = addMs(now, opts.lockTtlMs);

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

  async function processOneReminder() {
    const reminder = await claimDueReminder();
    if (!reminder) return false;

    const reminderId = String(reminder._id);

    const text = `Reminder:\n\n${reminder.text}`;

    try {
      await opts.sendMessage(reminder.chatId, text, buildReminderButtons(reminderId));
      console.log("[SCHEDULER] Sent reminder:", reminderId, "to chatId:", reminder.chatId);
    } catch (e) {
      console.error("[SCHEDULER] Send failed for reminder:", reminderId, e);

      // Release lock sooner so it can retry
      await Reminder.updateOne(
        { _id: reminder._id, "lock.lockedBy": opts.instanceId },
        { $set: { "lock.lockExpiresAt": new Date(0) } }
      );

      return true;
    }

    const now = nowDate();

    // If repeating, compute next. If not, mark sent.
    const schedule = reminder.schedule;
    const next = computeNextForSchedule({ timezone: reminder.timezone, schedule, lastRunAt: now });

    if (next) {
      await Reminder.updateOne(
        { _id: reminder._id, "lock.lockedBy": opts.instanceId },
        {
          $set: {
            lastRunAt: now,
            nextRunAt: next
          }
        }
      );
    } else {
      await Reminder.updateOne(
        { _id: reminder._id, "lock.lockedBy": opts.instanceId },
        {
          $set: {
            lastRunAt: now,
            status: "sent"
          }
        }
      );
    }

    return true;
  }

  async function claimDueHabit() {
    const now = nowDate();
    const lockExpiresAt = addMs(now, opts.lockTtlMs);

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

  async function processOneHabit() {
    const habit = await claimDueHabit();
    if (!habit) return false;

    // Skeleton for habits still logs only for now
    console.log("[SCHEDULER] Habit ping due:", String(habit._id), "| name:", habit.name);

    // Push out by 1 minute so it doesn't loop
    const now = nowDate();
    await Habit.updateOne(
      { _id: habit._id, "lock.lockedBy": opts.instanceId },
      { $set: { lastRunAt: now, nextRunAt: addMs(now, 60_000) } }
    );

    return true;
  }

  async function tick() {
    if (isTickRunning) return;
    isTickRunning = true;

    try {
      for (let i = 0; i < 5; i++) {
        const worked = await processOneReminder();
        if (!worked) break;
      }

      for (let i = 0; i < 5; i++) {
        const worked = await processOneHabit();
        if (!worked) break;
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