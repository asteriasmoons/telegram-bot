import { Telegraf, Markup } from "telegraf";

import { registerRemindersFlow as registerCreateRemindFlow } from "./flows/remind";
import { registerRemindersListFlow } from "./flows/reminders";
import { registerChatIdCommand } from "./commands/chatId";
import { requireChannel } from "./commands/requireChannel";
import { registerUserIdCommand } from "./commands/userid";
import { registerGroupIdCommand } from "./commands/groupid";

import { register as registerEventAdd } from "./commands/event-add";
import { register as registerEventList } from "./commands/event-list";
import { register as registerEventEdit } from "./commands/event-edit";
import { register as registerEventDelete } from "./commands/event-delete";

import { registerJournalFlow } from "./commands/journal";
import { registerJournalsFlow } from "./commands/journals";

import { registerPremium } from "./commands/premium";

import { registerSupportCommand } from "./commands/support";
import { registerSupportActions } from "./actions/supportActions";
import { registerSupportRouter } from "./middleware/supportRouter";
import { registerAdminReplyRouter } from "./middleware/adminReplyRouter";

import { registerPromptCommand } from "./commands/prompt";


import { UserSettings } from "./models/UserSettings";
import { Reminder } from "./models/Reminder";
import { addMinutes } from "./utils/time";

export function createBot(token: string) {
  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    console.log("Update received:", ctx.updateType);
    return next();
  });

  // 🔒 START COMMAND (gated)
  bot.start(requireChannel, async (ctx) => {
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
      "Hello lovely. Welcome to the Lystaria Bot experience! This bot was created with intention in mind for every day living.\n\nBot Commands:\n/start\n/ping\n/remind\n/reminders\n\nReminders deliver to DM.\nMore coming soon!"
    );

    // Persistent menu button
    const url = process.env.WEBAPP_URL;
    if (url && chat?.id) {
      await ctx.telegram.setChatMenuButton({
        chatId: chat.id,
        menuButton: {
          type: "web_app",
          text: "Open App",
          web_app: { url }
        }
      });
    }
  });

  // 🔒 PING (gated)
  bot.command("ping", requireChannel, async (ctx) => {
    await ctx.reply("pong");
  });

  // 🔒 MINI APP OPEN (gated)
  bot.command("reminders_app", requireChannel, async (ctx) => {
    const url = process.env.WEBAPP_URL;
    if (!url) {
      await ctx.reply("Mini app URL is not configured yet.");
      return;
    }

    await ctx.reply(
      "Open your Reminder Manager:",
      Markup.inlineKeyboard([
        Markup.button.webApp("Open Reminder Manager", url),
      ])
    );
  });

  // 🔄 Refresh button after joining channel
  bot.action("check_channel", requireChannel, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Access granted! You’re all set.");
  });

  // Reminder action buttons (already gated implicitly via reminder ownership)
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
      {
        $set: {
          nextRunAt: addMinutes(new Date(), minutes),
          status: "scheduled",
        },
      }
    );

    await ctx.reply(`Snoozed for ${minutes} minutes.`);
  });

  bot.action(/^r:del:/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = (ctx.callbackQuery as any).data.split(":")[2];
    await Reminder.updateOne({ _id: id }, { $set: { status: "deleted" } });
    await ctx.reply("Deleted.");
  });
  
    // JOURNAL COMMANDS/FLOWS
  registerJournalFlow(bot);
  registerJournalsFlow(bot);

  // 🔒 FLOWS (gated inside their own logic if needed)
  registerCreateRemindFlow(bot);
  registerRemindersListFlow(bot);
  registerChatIdCommand(bot);
  
  // Register EVENT commands
  registerEventAdd(bot);
  registerEventList(bot);
  registerEventEdit(bot);
  registerEventDelete(bot)
  
  // ID COMMANDS
  registerUserIdCommand(bot);
  registerGroupIdCommand(bot);
  
  // PREMIUM COMMAND
  registerPremium(bot);
  
  // TICKET SUPPORT COMMANDS
registerSupportCommand(bot);
registerSupportActions(bot);

// Order matters: user router first, admin router second is fine.
// Both ignore what they shouldn't handle.
registerSupportRouter(bot);
registerAdminReplyRouter(bot);

// PROMPT COMMAND
registerPromptCommand(bot);


  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}