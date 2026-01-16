import { Telegraf, Markup } from "telegraf";
import { registerRemindFlow } from "./flows/remind";
import { UserSettings } from "./models/UserSettings";

export function createBot(token: string) {
  const bot = new Telegraf(token);

  // Log update type (helps debugging)
  bot.use(async (ctx, next) => {
    console.log("Update received:", ctx.updateType);
    return next();
  });

  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const chat = ctx.chat;

    if (userId && chat && chat.type === "private") {
      // Save DM chat id so reminders can always be delivered to DM
      await UserSettings.findOneAndUpdate(
        { userId },
        {
          $set: {
            userId,
            dmChatId: chat.id
          },
          $setOnInsert: {
            timezone: "America/Chicago",
            quietHours: { enabled: false, start: "23:00", end: "08:00" }
          }
        },
        { upsert: true, new: true }
      );
    }

    await ctx.reply(
      "Bot is alive.\n\nUse /remind to create a reminder.\nYour reminders will be delivered to DM (private chat)."
    );
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  // Reminder delivery buttons (will be used by scheduler messages)
  bot.action(/^r:done:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Marked done.");
  });

  bot.action(/^r:snooze:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Snoozed.");
  });

  bot.action(/^r:del:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("Deleted.");
  });

  // Register /remind flow
  registerRemindFlow(bot);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}