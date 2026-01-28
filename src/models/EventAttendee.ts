// models/EventAttendee.ts
import mongoose, { Schema, Model, Types } from "mongoose";

export type RSVPStatus = "going" | "maybe" | "declined";

export type EventAttendeeDoc = {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  userId: number;
  rsvp: RSVPStatus;
  joinedAt: Date;
};

const EventAttendeeSchema = new Schema<EventAttendeeDoc>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    rsvp: {
      type: String,
      enum: ["going", "maybe", "declined"],
      required: true,
      default: "going",
    },
    joinedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  { timestamps: false }
);

// prevent duplicate joins
EventAttendeeSchema.index({ eventId: 1, userId: 1 }, { unique: true });

export const EventAttendee: Model<EventAttendeeDoc> =
  (mongoose.models.EventAttendee as Model<EventAttendeeDoc>) ||
  mongoose.model<EventAttendeeDoc>("EventAttendee", EventAttendeeSchema);