import { Telegraf, Context } from "telegraf";

/**
 * /chatid
 * Returns the current chat's ID and type.
 * Works in DMs, groups, and channels.
 */
export function registerChatIdCommand(bot: Telegraf<Context>) {
  // 🔹 DMs + groups
  bot.command("chatid", async (ctx) => {
    if (!ctx.chat) return;

    await ctx.reply(
      `Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}`
    );
  });

  // 🔹 Channels (channel_post updates)
  bot.on("channel_post", async (ctx, next) => {
    const post = ctx.channelPost;

    // Safely extract text or caption
    const text =
      ("text" in post && typeof post.text === "string" && post.text.trim()) ||
      ("caption" in post && typeof post.caption === "string" && post.caption.trim()) ||
      "";

    if (!text) return next();

    // Match /chatid or /chatid@BotUsername
    if (!/^\/chatid(@\w+)?$/.test(text)) return;

    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}`
    );
  });
}