// src/commands/info.ts
import { Telegraf, Markup, Context } from "telegraf";

const CHANNEL_URL = "https://t.me/lystaria";
const GROUP_URL = "https://t.me/lystariagroup";

export function registerInfoCommand(bot: Telegraf<Context>) {
  bot.command("info", async (ctx, next) => {
    const text =
      `<b>Lystaria Land</b>\n` +
        `<blockquote>` +
      `A calm space for routines, reflection, and building a life that feels like home.\n\n` +
      `<b>Where to go</b>\n` +
      `• The channel is for announcements, updates, and releases.\n` +
      `• The group is for discussion, support, and community.\n\n` +
       `<blockquote>` +
      `<i>Use the buttons below to open the right space.</i>`;

    await ctx.reply(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url("Join Channel", CHANNEL_URL),
          Markup.button.url("Join Group", GROUP_URL),
        ],
      ]),
   link_preview_options: { is_disabled: true },          
          });

// IMPORTANT: allow other middleware / flows to continue
    return next();
  });
}