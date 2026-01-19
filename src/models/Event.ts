import mongoose, { Schema, Model, Types } from "mongoose";

export type EventDoc = {
  _id: Types.ObjectId;
  userId: number; // Telegram user id
  title: string;
  description?: string;
  startDate: Date; // Event start
  endDate?: Date; // Event end (optional, for multi-day events)
  allDay: boolean; // All-day event or specific time
  color?: string; // Hex color for event (optional)
  location?: string;
  reminderId?: Types.ObjectId; // Link to a reminder (optional)
  createdAt: Date;
  updatedAt: Date;
};

const EventSchema = new Schema<EventDoc>(
  {
    userId: { type: Number, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, required: false },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, required: false },
    allDay: { type: Boolean, required: true, default: false },
    color: { type: String, required: false },
    location: { type: String, required: false },
    reminderId: { type: Schema.Types.ObjectId, required: false, ref: "Reminder" }
  },
  { timestamps: true }
);

// Index for efficient date range queries
EventSchema.index({ userId: 1, startDate: 1 });

export const Event: Model<EventDoc> =
  (mongoose.models.Event as Model<EventDoc>) ||
  mongoose.model<EventDoc>("Event", EventSchema);
