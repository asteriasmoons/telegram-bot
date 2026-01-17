import { Telegraf } from "telegraf";
import { DateTime } from "luxon";
import { Reminder } from "./models/Reminder";
import { UserSettings } from "./models/UserSettings";

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60_60_000);
}

function addWeeks(date: Date, weeks: number) {
  return addDays(date, weeks * 7);
}

function computeNextDaily(nextRunAt: Date, timezone: string) {
  const dt = DateTime.fromJSDate(nextRunAt, { zone: timezone }).plus({ days: 1 });
  return dt.toJSDate();
}

function computeNextWeekly(nextRunAt: Date, timezone: string) {
  const dt = DateTime.fromJSDate(nextRunAt, { zone: timezone }).plus({ weeks: 1 });
  return dt.toJSDate();
}

export function startReminderScheduler(bot: Telegraf<any>, pollIntervalMs = 10_000) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;

    try {
      const now = new Date();

      const due = await Reminder.find({
        status: { $in: ["scheduled", "active"] },
        nextRunAt: { $lte: now }
      })
        .sort({ nextRunAt: 1 })
        .limit(20);

      for (const reminder of due) {
        const settings = await UserSettings.findOne({ userId: reminder.userId }).lean();

        // If we don't have a DM chat ID, we can't deliver
        if (!settings?.dmChatId) {
          await Reminder.updateOne({ _id: reminder._id }, { $set: { status: "error" } });
          continue;
        }

        // Send the reminder message to DM (message only; no "Reminder:" prefix)
        await bot.telegram.sendMessage(settings.dmChatId, reminder.text, {
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

        // Decide the next run based on schedule
        const timezone = settings.timezone || "America/Chicago";
        const scheduleKind = reminder.schedule?.kind || "once";

        if (scheduleKind === "daily") {
          const next = computeNextDaily(reminder.nextRunAt, timezone);
          await Reminder.updateOne({ _id: reminder._id }, { $set: { nextRunAt: next, status: "scheduled" } });
          continue;
        }

        if (scheduleKind === "weekly") {
          const next = computeNextWeekly(reminder.nextRunAt, timezone);
          await Reminder.updateOne({ _id: reminder._id }, { $set: { nextRunAt: next, status: "scheduled" } });
          continue;
        }

        if (scheduleKind === "interval") {
          const mins = reminder.schedule?.intervalMinutes;

          if (!mins || !Number.isFinite(mins) || mins <= 0) {
            // Broken interval schedule -> mark error so it doesn't spam
            await Reminder.updateOne({ _id: reminder._id }, { $set: { status: "error" } });
            continue;
          }

          const next = addMinutes(reminder.nextRunAt, mins);
          await Reminder.updateOne({ _id: reminder._id }, { $set: { nextRunAt: next, status: "scheduled" } });
          continue;
        }

        // Once: mark sent
        await Reminder.updateOne({ _id: reminder._id }, { $set: { status: "sent" } });
      }
    } catch (err) {
      console.error("Scheduler tick error:", err);
    } finally {
      running = false;
    }
  }

  console.log("Reminder scheduler started.");
  tick().catch(() => {});
  return setInterval(() => tick().catch(() => {}), pollIntervalMs);
}