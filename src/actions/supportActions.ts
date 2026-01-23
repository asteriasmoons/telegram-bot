import { Telegraf, Markup } from "telegraf";
import { createTicket } from "../utils/tickets";
import { Ticket } from "../models/Ticket";
import { TicketMessage } from "../models/TicketMessage";
import { AdminSession } from "../models/AdminSession";

const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID);

function userCloseButton(ticketId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Close Support Ticket", `support:close:${ticketId}`),
  ]);
}

function adminTicketButtons(ticketId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Set Active Ticket", `admin:setActive:${ticketId}`),
    Markup.button.callback("Clear Active Ticket", "admin:clearActive"),
    Markup.button.callback("Close Ticket", `support:close:${ticketId}`),
  ]);
}

export function registerSupportActions(bot: Telegraf) {
  bot.action("support:open", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      if (!userId || !chatId) return;

      if (ctx.chat?.type !== "private") {
        await ctx.reply("Please open support in DM for privacy. Run /support in DM with me.");
        return;
      }

      const ticket = await createTicket(userId, chatId);

      await ctx.reply(
        `Your support ticket is open.\nTicket ID: ${ticket.ticketId}\n\nSend your message(s) here and I’ll receive them directly.`,
        userCloseButton(ticket.ticketId)
      );

      // Notify you (admin DM)
      if (Number.isFinite(ADMIN_USER_ID) && ADMIN_USER_ID > 0) {
        const fromLine = ctx.from?.username ? `@${ctx.from.username}` : "no username";
        await ctx.telegram.sendMessage(
          ADMIN_USER_ID,
          `New support ticket opened.\nTicket ID: ${ticket.ticketId}\nFrom: ${fromLine}\nUser ID: ${userId}`,
          adminTicketButtons(ticket.ticketId)
        );
      }
    } catch {
      await ctx.reply("Something went wrong opening your ticket. Try again.");
    }
  });

  bot.action(/^support:close:(.+)$/i, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const ticketId = String(ctx.match?.[1] || "").trim().toUpperCase();
      const actorId = ctx.from?.id;

      if (!ticketId || !actorId) return;

      const ticket = await Ticket.findOne({ ticketId }).lean();
      if (!ticket) {
        await ctx.reply("I couldn’t find that ticket.");
        return;
      }

      // Only ticket owner or admin can close
      if (ticket.userId !== actorId && actorId !== ADMIN_USER_ID) {
        await ctx.reply("You can’t close a ticket that isn’t yours.");
        return;
      }

      if (ticket.status === "closed") {
        await ctx.reply(`Ticket already closed: ${ticketId}`);
        return;
      }

      await Ticket.updateOne({ ticketId }, { $set: { status: "closed" } });

      await TicketMessage.create({
        ticketId,
        from: "admin",
        text: "[ticket closed]",
      });

      await ctx.reply(`Ticket closed: ${ticketId}\nIf you need anything else, run /support again.`);

      if (Number.isFinite(ADMIN_USER_ID) && ADMIN_USER_ID > 0) {
        await ctx.telegram.sendMessage(ADMIN_USER_ID, `Ticket closed: ${ticketId}`);
      }
    } catch {
      await ctx.reply("Something went wrong closing the ticket.");
    }
  });

  bot.action(/^admin:setActive:(.+)$/i, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from?.id !== ADMIN_USER_ID) return;

    const ticketId = String(ctx.match?.[1] || "").trim().toUpperCase();
    if (!ticketId) return;

    const ticket = await Ticket.findOne({ ticketId }).lean();
    if (!ticket) {
      await ctx.reply("Ticket not found.");
      return;
    }
    if (ticket.status !== "open") {
      await ctx.reply("That ticket is closed.");
      return;
    }

    await AdminSession.updateOne(
      { adminUserId: ADMIN_USER_ID },
      { $set: { activeTicketId: ticketId } },
      { upsert: true }
    );

    await ctx.reply(`Active ticket set to ${ticketId}. Now just type your reply normally.`);
  });

  bot.action("admin:clearActive", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from?.id !== ADMIN_USER_ID) return;

    await AdminSession.updateOne(
      { adminUserId: ADMIN_USER_ID },
      { $unset: { activeTicketId: "" } },
      { upsert: true }
    );

    await ctx.reply("Active ticket cleared.");
  });
}