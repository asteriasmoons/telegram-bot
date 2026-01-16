import mongoose, { Schema, Model, Types } from "mongoose";

export type DraftKind = "reminder" | "habit";

export type DraftStep =
  | "choose_time"
  | "choose_repeat"
  | "enter_text"
  | "confirm"
  | "done";

export type ReminderDraftAwaiting = "date" | "time" | "interval" | "message";

export type ReminderDraftData = {
  // Date/time selection
  dateISO?: string;    // "YYYY-MM-DD"
  timeHHMM?: string;   // "HH:MM"

  // Message
  text?: string;

  // Frequency selection
  repeatKind?: "none" | "daily" | "weekly" | "interval";

  // Weekly
  daysOfWeek?: number[]; // Sun=0..Sat=6 (optional for future)

  // Interval
  intervalMinutes?: number;

  // Used to route typed input after pressing a "custom" button
  awaiting?: ReminderDraftAwaiting;
};

export type HabitDraftData = {
  name?: string;
  description?: string;
  scheduleKind?: "daily" | "weekly" | "interval";
  timeOfDay?: string;      // "HH:MM"
  daysOfWeek?: number[];
  intervalMinutes?: number;
  nextRunAt?: Date;
};

export type DraftDoc = {
  _id: Types.ObjectId;

  userId: number;
  chatId: number;

  kind: DraftKind;
  step: DraftStep;

  timezone: string;

  reminder?: ReminderDraftData;
  habit?: HabitDraftData;

  // TTL field: Mongo will delete the doc after expiresAt
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
};

const ReminderDraftSchema = new Schema<ReminderDraftData>(
  {
    dateISO: { type: String, required: false },
    timeHHMM: { type: String, required: false },

    text: { type: String, required: false },

    repeatKind: { type: String, required: false, enum: ["none", "daily", "weekly", "interval"] },

    daysOfWeek: { type: [Number], required: false },

    intervalMinutes: { type: Number, required: false },

    awaiting: { type: String, required: false, enum: ["date", "time", "interval", "message"] }
  },
  { _id: false }
);

const HabitDraftSchema = new Schema<HabitDraftData>(
  {
    name: { type: String, required: false },
    description: { type: String, required: false },
    scheduleKind: { type: String, required: false, enum: ["daily", "weekly", "interval"] },
    timeOfDay: { type: String, required: false },
    daysOfWeek: { type: [Number], required: false },
    intervalMinutes: { type: Number, required: false },
    nextRunAt: { type: Date, required: false }
  },
  { _id: false }
);

const DraftSchema = new Schema<DraftDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true, index: true },

    kind: { type: String, required: true, enum: ["reminder", "habit"], index: true },
    step: { type: String, required: true, index: true },

    timezone: { type: String, required: true },

    reminder: { type: ReminderDraftSchema, required: false },
    habit: { type: HabitDraftSchema, required: false },

expiresAt: { type: Date, required: true },
  { timestamps: true }
);

// TTL index: documents expire automatically
DraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Useful for fetching current draft per user/kind
DraftSchema.index({ userId: 1, kind: 1 });

export const Draft: Model<DraftDoc> =
  (mongoose.models.Draft as Model<DraftDoc>) ||
  mongoose.model<DraftDoc>("Draft", DraftSchema);