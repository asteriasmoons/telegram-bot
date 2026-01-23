import { Telegraf, Markup } from "telegraf";
import { Ticket } from "../models/Ticket";
import { TicketMessage } from "../models/TicketMessage";
import { AdminSession } from "../models/AdminSession";

const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID);

function extractTicketId(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(/Support Ticket:\s*(TKT-[A-Z0-9]+)/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

function userCloseButton(ticketId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Close Support Ticket", `support:close:${ticketId}`),
  ]);
}

export function registerAdminReplyRouter(bot: Telegraf) {
  bot.on("message", async (ctx, next) => {
    // Only process your DM messages to the bot
    if (ctx.chat?.type !== "private") return next();
    if (ctx.from?.id !== ADMIN_USER_ID) return next();

    const msgText = (ctx.message as any)?.text as string | undefined;
    if (!msgText) return next();

    // Let commands pass through to other handlers if you keep any
    if (msgText.startsWith("/")) return next();

    // Priority 1: reply-to routing
    const replyTo = (ctx.message as any)?.reply_to_message;
    const repliedText = (replyTo?.text as string | undefined) || undefined;
    let ticketId = extractTicketId(repliedText);

    // Priority 2: active ticket routing
    if (!ticketId) {
      const session = await AdminSession.findOne({ adminUserId: ADMIN_USER_ID }).lean();
      if (session?.activeTicketId) ticketId = session.activeTicketId.toUpperCase();
    }

    // If no ticket target, do nothing (or you can warn if you prefer)
    if (!ticketId) return;

    const ticket = await Ticket.findOne({ ticketId }).lean();
    if (!ticket) {
      await ctx.reply("I couldn’t find that ticket.");
      return;
    }

    if (ticket.status !== "open") {
      await ctx.reply("That ticket is closed.");
      return;
    }

    // Send message to user
    await ctx.telegram.sendMessage(
      ticket.userChatId,
      `Support reply (${ticketId}):\n${msgText}`,
      userCloseButton(ticketId)
    );

    // Persist transcript + timestamps
    await TicketMessage.create({ ticketId, from: "admin", text: msgText });
    await Ticket.updateOne({ ticketId }, { $set: { lastAdminMessageAt: new Date() } });

    // Optional confirmation to admin
    await ctx.reply(`Sent to ${ticketId}.`);
    return;
  });
}