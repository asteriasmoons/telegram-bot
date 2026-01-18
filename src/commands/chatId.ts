import { Telegraf, Context } from "telegraf";

type MyContext = Context; // extend later if you add session, etc.

export function registerChatIdCommand(bot: Telegraf<MyContext>) {
  bot.command("chatid", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    const chatId = chat.id;
    const chatType = chat.type;

    // title exists for groups/channels, username may exist for public chats/channels
    const title =
      (chat as any).title ??
      (chat as any).username ??
      (ctx.from?.username ? `@${ctx.from.username}` : "Private Chat");

    await ctx.reply(
      [
        "Chat Info",
        `ID: ${chatId}`,
        `Type: ${chatType}`,
        `Title/Name: ${title}`,
      ].join("\n")
    );
  });
}