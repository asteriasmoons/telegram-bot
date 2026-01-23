import { Schema, model, Document } from "mongoose";

export type TicketStatus = "open" | "closed";

export interface TicketDoc extends Document {
  ticketId: string;
  userId: number;
  userChatId: number;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt?: Date;
  lastAdminMessageAt?: Date;
}

const TicketSchema = new Schema<TicketDoc>(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    userChatId: { type: Number, required: true },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },

    lastUserMessageAt: { type: Date },
    lastAdminMessageAt: { type: Date },
  },
  { timestamps: true }
);

// Helps queries like: "find open ticket for this user"
TicketSchema.index({ userId: 1, status: 1 });

export const Ticket = model<TicketDoc>("Ticket", TicketSchema);