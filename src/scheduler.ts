import { Telegraf } from "telegraf";
import { Reminder } from "./models/Reminder";
import { UserSettings } from "./models/UserSettings";
import { addMinutes, addDays } from "./utils/time";
import { makeInstanceId } from "./schedulerInstance";

type SchedulerOptions = {
  pollIntervalMs: number;
  lockTtlMs: number;
  instanceId: string;
};

export function createScheduler(opts: SchedulerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;

    try {
      const now = new Date();

      const due = await Reminder.find({
        status: "scheduled",
        nextRunAt: { $lte: now }
      }).limit(10);

      for (const reminder of due) {
        const settings = await UserSettings.findOne({
          userId: reminder.userId
        });

        if (!settings?.dmChatId) {
          await Reminder.updateOne(
            { _id: reminder._id },
            { $set: { status: "error" } }
          );
          continue;
        }

        // Send reminder message (Option A: message only)
        await reminder.bot.telegram.sendMessage(
          settings.dmChatId,
          reminder.message,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Done", callback_data: `r:done:${reminder._id}` },
                  { text: "Snooze 10m", callback_data: `r:snooze:10:${reminder._id}` },
                  { text: "Snooze 1h", callback_data: `r:snooze:60:${reminder._id}` }
                ],
                [
                  { text: "Delete", callback_data: `r:del:${reminder._id}` }
                ]
              ]
            }
          }
        );

        // Handle repeat logic
        if (reminder.repeatKind === "daily") {
          const next = addDays(reminder.nextRunAt, 1);
          await Reminder.updateOne(
            { _id: reminder._id },
            { $set: { nextRunAt: next } }
          );
        } else if (reminder.repeatKind === "interval" && reminder.intervalMinutes) {
          const next = addMinutes(reminder.nextRunAt, reminder.intervalMinutes);
          await Reminder.updateOne(
            { _id: reminder._id },
            { $set: { nextRunAt: next } }
          );
        } else {
          await Reminder.updateOne(
            { _id: reminder._id },
            { $set: { status: "sent" } }
          );
        }
      }
    } catch (err) {
      console.error("Scheduler error:", err);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      console.log("Scheduler started:", opts.instanceId);
      timer = setInterval(tick, opts.pollIntervalMs);
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log("Scheduler stopped");
    }
  };
}