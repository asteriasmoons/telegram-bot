import { Telegraf, Markup } from "telegraf";
import { getOpenTicketForUser } from "../utils/tickets";
import { Ticket } from "../models/Ticket";
import { TicketMessage } from "../models/TicketMessage";

const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID);

function adminTicketButtons(ticketId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Set Active Ticket", `admin:setActive:${ticketId}`),
    Markup.button.callback("Clear Active Ticket", "admin:clearActive"),
    Markup.button.callback("Close Ticket", `support:close:${ticketId}`),
  ]);
}

export function registerSupportRouter(bot: Telegraf) {
  bot.on("message", async (ctx, next) => {
    // Only handle user DMs
    if (ctx.chat?.type !== "private") return next();

    // Ignore admin messages here; admin has their own router
    if (ctx.from?.id === ADMIN_USER_ID) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    // Handle only text messages in this version
    const msgText = (ctx.message as any)?.text as string | undefined;
    if (!msgText) return next();

    // Don’t treat commands as ticket text
    if (msgText.startsWith("/")) return next();

    const ticket = await getOpenTicketForUser(userId);
    if (!ticket) return next();

    await TicketMessage.create({
      ticketId: ticket.ticketId,
      from: "user",
      text: msgText,
      tgMessageId: (ctx.message as any)?.message_id,
    });

    await Ticket.updateOne(
      { ticketId: ticket.ticketId },
      { $set: { lastUserMessageAt: new Date() } }
    );

    if (Number.isFinite(ADMIN_USER_ID) && ADMIN_USER_ID > 0) {
      const fromLine = ctx.from?.username ? `@${ctx.from.username}` : "no username";
      const header =
        `Support Ticket: ${ticket.ticketId}\n` +
        `From: ${fromLine}\n` +
        `User ID: ${userId}\n\n`;

      await ctx.telegram.sendMessage(
        ADMIN_USER_ID,
        header + msgText,
        adminTicketButtons(ticket.ticketId)
      );
    }

    // Optional confirmation to user
    await ctx.reply(`Got it. Your message was sent to support (${ticket.ticketId}).`);
    return;
  });
}