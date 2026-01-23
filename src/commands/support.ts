import { Telegraf, Markup } from "telegraf";

export function registerSupportCommand(bot: Telegraf) {
  bot.command("support", async (ctx) => {
    // If used in a group, push them to DM for privacy
    const chatType = ctx.chat?.type;
    if (chatType && chatType !== "private") {
      const me = await ctx.telegram.getMe();
      const deepLink = `https://t.me/${me.username}?start=support`;

      await ctx.reply(
        "Support tickets are handled in DM for privacy. Tap below to open support.",
        Markup.inlineKeyboard([Markup.button.url("Open Support DM", deepLink)])
      );
      return;
    }

    await ctx.reply(
      "Need help? Tap below to open a private support ticket.",
      Markup.inlineKeyboard([Markup.button.callback("Open Support Ticket", "support:open")])
    );
  });

  bot.start(async (ctx) => {
    const payload = (ctx.startPayload || "").trim();

    if (payload === "support") {
      await ctx.reply(
        "Need help? Tap below to open a private support ticket.",
        Markup.inlineKeyboard([Markup.button.callback("Open Support Ticket", "support:open")])
      );
      return;
    }

    // If you already have a /start handler elsewhere, remove this start() and merge the payload branch into yours.
  });
}