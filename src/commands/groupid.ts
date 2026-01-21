import type { Telegraf } from "telegraf";

export function registerGroupIdCommand(bot: Telegraf) {
  bot.command("groupid", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) {
      await ctx.reply("I couldn’t determine the chat ID.");
      return;
    }

    if (chat.type === "private") {
      await ctx.reply(
        `💬 This is a private chat.\n\nChat ID (same as your user ID):\n<code>${chat.id}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await ctx.reply(`👥 Group Chat ID:\n\n<code>${chat.id}</code>`, {
      parse_mode: "HTML",
    });
  });
}