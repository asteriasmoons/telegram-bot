import { Telegraf, Context } from "telegraf";

export function registerChatIdCommand(bot: Telegraf<Context>) {
  // 🔹 Normal messages (DMs, groups)
  bot.command("chatid", async (ctx) => {
    if (!ctx.chat) return;

    await ctx.reply(
      `Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}`
    );
  });

  // 🔹 Channel posts (channels use channel_post updates)
  bot.on("channel_post", async (ctx) => {
    const text = ctx.channelPost?.text?.trim();
    if (!text) return;

    // Matches /chatid or /chatid@YourBotName
    if (!/^\/chatid(@\w+)?$/.test(text)) return;

    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}`
    );
  });
}