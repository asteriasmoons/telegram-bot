import { Telegraf } from "telegraf";

import { registerRemindFlow } from "./flows/remind";
import { registerRemindersFlow } from "./flows/reminders";

import { UserSettings } from "./models/UserSettings";
import { Reminder } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function createBot(token: string) {
  const bot = new Telegraf(token);

  // Basic update log (helps debugging without being noisy)
  bot.use(async (ctx, next) => {
    console.log("Update received:", ctx.updateType);
    return next();
  });

  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const chat = ctx.chat;

    // Save DM chat ID for delivery
    if (userId && chat && chat.type === "private") {
      await UserSettings.findOneAndUpdate(
        { userId },
        {
          $set: { userId, dmChatId: chat.id },
          $setOnInsert: {
            timezone: "America/Chicago",
            quietHours: { enabled: false, start: "23:00", end: "08:00" }
          }
        },
        { upsert: true, new: true }
      );
    }

    await ctx.reply(
      "Bot is alive.\n\nCommands:\n/start\n/ping\n/remind\n/reminders\n\nReminders deliver to DM (private chat)."
    );
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  /* ----------------------------
     Reminder delivery buttons
     These are pressed on the reminder message that fires in DM.
  ----------------------------- */

  bot.action(/^r:done:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = (ctx.callbackQuery as any)?.data as string;
    const reminderId = data.split(":")[2];

    await Reminder.updateOne(
      { _id: reminderId },
      { $set: { status: "sent" } }
    );

    await ctx.reply("Marked done.");
  });

  bot.action(/^r:snooze:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = (ctx.callbackQuery as any)?.data as string;
    const parts = data.split(":"); // r:snooze:10:<id>
    const minutes = Number(parts[2]);
    const reminderId = parts[3];

    if (!Number.isFinite(minutes) || minutes <= 0) {
      await ctx.reply("Invalid snooze time.");
      return;
    }

    const nextRunAt = addMinutes(new Date(), minutes);

    await Reminder.updateOne(
      { _id: reminderId },
      { $set: { nextRunAt, status: "scheduled" } }
    );

    await ctx.reply(`Snoozed for ${minutes} minutes.`);
  });

  bot.action(/^r:del:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = (ctx.callbackQuery as any)?.data as string;
    const reminderId = data.split(":")[2];

    await Reminder.updateOne(
      { _id: reminderId },
      { $set: { status: "deleted" } }
    );

    await ctx.reply("Deleted.");
  });

  /* ----------------------------
     Flows
  ----------------------------- */

  // Create reminders
  registerRemindFlow(bot);

  // List/edit scheduled/active reminders
  registerRemindersFlow(bot);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}