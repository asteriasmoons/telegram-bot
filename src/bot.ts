import { Telegraf } from "telegraf";

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
        quietHours: { enabled: false, start: "23:00", end: "08:00" }
      }
    },
    { upsert: true, new: true }
  );
}

await ctx.reply(
  "Bot is alive.\n\nCommands:\n/start\n/ping\n/remind\n/reminders\n\nReminders deliver to DM."
);


});

bot.command("ping", async (ctx) => {
await ctx.reply("pong");
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

// 🔹 Create reminder flow (/remind)
registerCreateRemindFlow(bot);

// 🔹 List/edit reminders (/reminders)
registerRemindersListFlow(bot);

// 🔌 Get Chat ID
registerChatIdCommand(bot);

bot.catch((err) => {
console.error("Bot error:", err);
});

return bot;
}