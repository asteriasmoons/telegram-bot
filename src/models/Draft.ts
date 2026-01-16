import mongoose, { Schema, Model, Types } from "mongoose";

export type DraftKind = "reminder" | "habit";

export type DraftStep =
  | "choose_time"
  | "enter_text"
  | "choose_repeat"
  | "confirm"
  | "done";

export type ReminderDraftData = {
  whenLabel?: string;      // e.g. "in 10 minutes", "tomorrow"
  nextRunAt?: Date;        // computed date
  text?: string;
  repeatKind?: "none" | "daily" | "weekly" | "interval";
  timeOfDay?: string;      // "HH:MM" if repeating
  daysOfWeek?: number[];   // weekly
  intervalMinutes?: number;
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
    whenLabel: { type: String, required: false },
    nextRunAt: { type: Date, required: false },
    text: { type: String, required: false },
    repeatKind: { type: String, required: false, enum: ["none", "daily", "weekly", "interval"] },
    timeOfDay: { type: String, required: false },
    daysOfWeek: { type: [Number], required: false },
    intervalMinutes: { type: Number, required: false }
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

    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

// TTL index: documents expire automatically
// NOTE: MongoDB Atlas may take 1–2 minutes (sometimes longer) to delete expired docs.
DraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Useful for fetching current draft per user/kind
DraftSchema.index({ userId: 1, kind: 1 });

export const Draft: Model<DraftDoc> =
  (mongoose.models.Draft as Model<DraftDoc>) ||
  mongoose.model<DraftDoc>("Draft", DraftSchema);