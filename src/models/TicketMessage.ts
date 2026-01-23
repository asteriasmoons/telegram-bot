import { Schema, model, Document } from "mongoose";

export type TicketFrom = "user" | "admin";

export interface TicketMessageDoc extends Document {
  ticketId: string;
  from: TicketFrom;
  text: string;
  tgMessageId?: number;
  createdAt: Date;
}

const TicketMessageSchema = new Schema<TicketMessageDoc>(
  {
    ticketId: { type: String, required: true, index: true },
    from: { type: String, enum: ["user", "admin"], required: true },
    text: { type: String, required: true },
    tgMessageId: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const TicketMessage = model<TicketMessageDoc>("TicketMessage", TicketMessageSchema);