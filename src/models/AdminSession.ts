import { Schema, model, Document } from "mongoose";

export interface AdminSessionDoc extends Document {
  adminUserId: number;
  activeTicketId?: string;
  updatedAt: Date;
}

const AdminSessionSchema = new Schema<AdminSessionDoc>(
  {
    adminUserId: { type: Number, required: true, unique: true, index: true },
    activeTicketId: { type: String, required: false },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const AdminSession = model<AdminSessionDoc>("AdminSession", AdminSessionSchema);