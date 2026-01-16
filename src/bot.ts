import { Telegraf, Markup } from "telegraf";

export function createBot(token: string) {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await ctx.reply(
      "Bot is alive. Press the button to test callbacks.",
      Markup.inlineKeyboard([
        Markup.button.callback("Test Button", "test:ping"),
      ])
    );
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.action("test:ping", async (ctx) => {
    await ctx.answerCbQuery("Callback received!");
    await ctx.reply("Button press worked ✅");
  });

  bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    // Avoid crashing on unexpected updates
    // (We keep it simple here; later we’ll add richer logging)
  });

  return bot;
}
