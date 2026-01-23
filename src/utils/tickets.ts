import crypto from "crypto";
import { Ticket } from "../models/Ticket";

export function makeTicketId() {
  // Example: TKT-3FA1C9
  return "TKT-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

export async function getOpenTicketForUser(userId: number) {
  return Ticket.findOne({ userId, status: "open" }).lean();
}

export async function createTicket(userId: number, userChatId: number) {
  // Only one open ticket per user
  const existing = await Ticket.findOne({ userId, status: "open" }).lean();
  if (existing) return existing;

  // Generate unique ticketId (retry on rare collisions)
  for (let i = 0; i < 5; i++) {
    const ticketId = makeTicketId();
    try {
      const doc = await Ticket.create({ ticketId, userId, userChatId, status: "open" });
      return doc.toObject();
    } catch (err: any) {
      if (err?.code === 11000) continue; // duplicate key
      throw err;
    }
  }

  throw new Error("Failed to generate unique ticket ID.");
}