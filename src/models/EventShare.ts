// models/EventShare.ts
import mongoose, { Schema, Model, Types } from "mongoose";

export type EventShareDoc = {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;   // references Event
  ownerUserId: number;       // must match Event.userId
  token: string;             // share code
  createdAt: Date;
  expiresAt?: Date;          // optional (future)
};

const EventShareSchema = new Schema<EventShareDoc>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    ownerUserId: {
      type: Number,
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: false,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const EventShare: Model<EventShareDoc> =
  (mongoose.models.EventShare as Model<EventShareDoc>) ||
  mongoose.model<EventShareDoc>("EventShare", EventShareSchema);