import mongoose, { Schema, Model, Types } from "mongoose";

export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export type RecurrenceEnd =
  | { kind: "never" }
  | { kind: "until"; until: Date }
  | { kind: "count"; count: number };

export type RecurrenceRule = {
  freq: RecurrenceFreq;
  interval: number;           // every X units (>= 1)
  byWeekday?: number[];       // weekly only: 0..6 (Sun..Sat)
  end?: RecurrenceEnd;        // optional
};

export type EventDoc = {
  _id: Types.ObjectId;
  userId: number;
  title: string;
  description?: string;
  startDate: Date;
  endDate?: Date;
  allDay: boolean;
  color?: string;
    location?: string;
  locationPlaceId?: string | null;
  locationCoords?: { lat: number; lng: number } | null;

  // Existing one-time reminder link (keep for non-recurring)
  reminderId?: Types.ObjectId;

  // New recurrence fields
  recurrence?: RecurrenceRule;          // if set => recurring series
  recurrenceExceptions?: string[];      // ISO keys like "2026-01-25" (skip that occurrence)

  createdAt: Date;
  updatedAt: Date;
};

const RecurrenceEndSchema = new Schema(
  {
    kind: { type: String, enum: ["never", "until", "count"], required: true },
    until: { type: Date, required: false },
    count: { type: Number, required: false }
  },
  { _id: false }
);

const RecurrenceRuleSchema = new Schema(
  {
    freq: { type: String, enum: ["daily", "weekly", "monthly", "yearly"], required: true },
    interval: { type: Number, required: true, min: 1 },
    byWeekday: { type: [Number], required: false }, // 0..6
    end: { type: RecurrenceEndSchema, required: false }
  },
  { _id: false }
);

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
    locationPlaceId: { type: String, default: null },
    locationCoords: {
      type: new Schema({ lat: { type: Number }, lng: { type: Number } }, { _id: false }),
      default: null,
    },
    reminderId: { type: Schema.Types.ObjectId, required: false, ref: "Reminder" },

    recurrence: { type: RecurrenceRuleSchema, required: false },
    recurrenceExceptions: { type: [String], required: false, default: [] }
  },
  { timestamps: true }
);

EventSchema.index({ userId: 1, startDate: 1 });
EventSchema.index({ userId: 1, "recurrence.freq": 1 });

export const Event: Model<EventDoc> =
  (mongoose.models.Event as Model<EventDoc>) ||
  mongoose.model<EventDoc>("Event", EventSchema);