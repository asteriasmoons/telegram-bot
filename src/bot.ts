import { Telegraf, Markup } from "telegraf";

import { registerRemindersFlow as registerCreateRemindFlow } from "./flows/remind";
import { registerRemindersListFlow } from "./flows/reminders";
import { registerChatIdCommand } from "./commands/chatId";

import { UserSettings } from "./models/UserSettings";
import { Reminder } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function createBot(token: string) {
  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    console.log("Update received:", ctx.updateType);
    return next();
  });

  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const chat = ctx.chat;

    if (userId && chat && chat.type === "private") {
      await UserSettings.findOneAndUpdate(
        { userId },
        {
          $set: { userId, dmChatId: chat.id },
          $setOnInsert: {
            timezone: "America/Chicago",
            quietHours: { enabled: false, start: "23:00", end: "08:00" },
          },
        },
        { upsert: true, new: true }
      );
    }

    await ctx.reply(
      "Bot is alive.\n\nCommands:\n/start\n/ping\n/remind\n/reminders\n/reminders_app\n\nReminders deliver to DM."
    );

    // ✅ Set the persistent "Open App" button in the chat (menu button)
    const url = process.env.WEBAPP_URL;
    if (url && chat?.id) {
      await ctx.telegram.setChatMenuButton({
        chatId: chat.id,
        menuButton: {
          type: "web_app",
          text: "Open App",
          webApp: { url },
        },
      });
    }
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("reminders_app", async (ctx) => {
    const url = process.env.WEBAPP_URL;
    if (!url) {
      await ctx.reply("Mini app URL is not configured yet.");
      return;
    }

    await ctx.reply(
      "Open your Reminder Manager:",
      Markup.inlineKeyboard([Markup.button.webApp("Open Reminder Manager", url)])
    );
  });

  // Reminder action buttons
  bot.action(/^r:done:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = (ctx.callbackQuery as any).data.split(":")[2];
    await Reminder.updateOne({ _id: id }, { $set: { status: "sent" } });
    await ctx.reply("Marked done.");
  });

  bot.action(/^r:snooze:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const [, , mins, id] = (ctx.callbackQuery as any).data.split(":");
    const minutes = Number(mins);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      await ctx.reply("Invalid snooze time.");
      return;
    }

    await Reminder.updateOne(
      { _id: id },
      { $set: { nextRunAt: addMinutes(new Date(), minutes), status: "scheduled" } }
    );

    await ctx.reply(`Snoozed for ${minutes} minutes.`);
  });

  bot.action(/^r:del:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = (ctx.callbackQuery as any).data.split(":")[2];
    await Reminder.updateOne({ _id: id }, { $set: { status: "deleted" } });
    await ctx.reply("Deleted.");
  });

  registerCreateRemindFlow(bot);
  registerRemindersListFlow(bot);
  registerChatIdCommand(bot);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}