import mongoose, { Schema, Model, Types } from "mongoose";

/* ----------------------------
   Draft core types
----------------------------- */

export type DraftKind = "reminder" | "habit";

export type DraftStep =
  | "choose_time"
  | "choose_repeat"
  | "enter_text"
  | "confirm"
  | "done";

/* ----------------------------
   Reminder draft types
----------------------------- */

export type ReminderDraftAwaiting =
  | "date"
  | "time"
  | "interval"
  | "message";

export type ReminderDraftData = {
  // Date & time selection
  dateISO?: string;        // YYYY-MM-DD
  timeHHMM?: string;       // HH:MM (24h)

  // Reminder message
  text?: string;

  // Frequency
  repeatKind?: "none" | "daily" | "weekly" | "interval";

  // Weekly (future-safe)
  daysOfWeek?: number[];   // Sun=0 .. Sat=6

  // Interval
  intervalMinutes?: number;

  // Used to route typed input
  awaiting?: ReminderDraftAwaiting;
};

/* ----------------------------
   Habit draft types (future)
----------------------------- */

export type HabitDraftData = {
  name?: string;
  description?: string;
  scheduleKind?: "daily" | "weekly" | "interval";
  timeOfDay?: string;      // HH:MM
  daysOfWeek?: number[];
  intervalMinutes?: number;
  nextRunAt?: Date;
};

/* ----------------------------
   Draft document
----------------------------- */

export type DraftDoc = {
  _id: Types.ObjectId;

  userId: number;
  chatId: number;

  kind: DraftKind;
  step: DraftStep;

  timezone: string;

  reminder?: ReminderDraftData;
  habit?: HabitDraftData;

  // TTL cleanup
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
};

/* ----------------------------
   Schemas
----------------------------- */

const ReminderDraftSchema = new Schema<ReminderDraftData>(
  {
    dateISO: { type: String },
    timeHHMM: { type: String },

    text: { type: String },

    repeatKind: {
      type: String,
      enum: ["none", "daily", "weekly", "interval"]
    },

    daysOfWeek: { type: [Number] },

    intervalMinutes: { type: Number },

    awaiting: {
      type: String,
      enum: ["date", "time", "interval", "message"]
    }
  },
  { _id: false }
);

const HabitDraftSchema = new Schema<HabitDraftData>(
  {
    name: { type: String },
    description: { type: String },
    scheduleKind: {
      type: String,
      enum: ["daily", "weekly", "interval"]
    },
    timeOfDay: { type: String },
    daysOfWeek: { type: [Number] },
    intervalMinutes: { type: Number },
    nextRunAt: { type: Date }
  },
  { _id: false }
);

const DraftSchema = new Schema<DraftDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true },

    kind: {
      type: String,
      required: true,
      enum: ["reminder", "habit"],
      index: true
    },

    step: { type: String, required: true },

    timezone: { type: String, required: true },

    reminder: { type: ReminderDraftSchema },
    habit: { type: HabitDraftSchema },

    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

/* ----------------------------
   Indexes
----------------------------- */

// TTL index -- Mongo will auto-delete expired drafts
DraftSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

// Fetch active draft per user
DraftSchema.index({ userId: 1, kind: 1 });

/* ----------------------------
   Model export
----------------------------- */

export const Draft: Model<DraftDoc> =
  (mongoose.models.Draft as Model<DraftDoc>) ||
  mongoose.model<DraftDoc>("Draft", DraftSchema);