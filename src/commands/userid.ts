import type { Telegraf } from "telegraf";

export function registerUserIdCommand(bot: Telegraf) {
  bot.command("userid", async (ctx) => {
    const user = ctx.from;
    if (!user) {
      await ctx.reply("I couldn’t determine your user ID.");
      return;
    }

    await ctx.reply(`🧍 Your Telegram User ID:\n\n<code>${user.id}</code>`, {
      parse_mode: "HTML",
    });
  });
}