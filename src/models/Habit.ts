import mongoose, { Schema, Model, Types } from "mongoose";

export type HabitStatus = "active" | "paused";

export type HabitUnit =
  | "minutes"
  | "hours"
  | "steps"
  | "cups"
  | "oz"
  | "ml"
  | "pages"
  | "count"
  | "sessions";

export type HabitCadence = "daily" | "weekly";

export type HabitReminderKind =
  | "off"
  | "times"
  | "hourly"
  | "every_x_minutes";

export type HabitReminderSchedule = {
  kind: HabitReminderKind;

  timesOfDay?: string[];

  everyHours?: number;

  everyMinutes?: number;

  windowStart?: string;
  windowEnd?: string;

  daysOfWeek?: number[];
};

export type HabitLock = {
  lockedAt?: Date;
  lockExpiresAt?: Date;
  lockedBy?: string;
};

export type HabitDoc = {
  _id: Types.ObjectId;

  userId: number;
  chatId: number;

  name: string;
  description?: string;

  status: HabitStatus;

  cadence: HabitCadence;
  targetCount: number;
  targetAmount?: number;
  unit: HabitUnit;

  timezone: string;

  reminderSchedule: HabitReminderSchedule;
  nextReminderAt?: Date;

  createdAt: Date;
  updatedAt: Date;
  lastRemindedAt?: Date;

  lock?: HabitLock;
};

const HabitReminderScheduleSchema = new Schema<HabitReminderSchedule>(
  {
    kind: {
      type: String,
      required: true,
      enum: ["off", "times", "hourly", "every_x_minutes"],
      default: "off",
    },

    timesOfDay: { type: [String], required: false, default: [] },

    everyHours: { type: Number, required: false, min: 1 },
    everyMinutes: { type: Number, required: false, min: 1 },

    windowStart: { type: String, required: false },
    windowEnd: { type: String, required: false },

    daysOfWeek: { type: [Number], required: false, default: [] },
  },
  { _id: false }
);

const HabitLockSchema = new Schema<HabitLock>(
  {
    lockedAt: { type: Date, required: false },
    lockExpiresAt: { type: Date, required: false, index: true },
    lockedBy: { type: String, required: false },
  },
  { _id: false }
);

const HabitSchema = new Schema<HabitDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true, index: true },

    name: { type: String, required: true, trim: true },
    description: { type: String, required: false, trim: true },

    status: {
      type: String,
      required: true,
      enum: ["active", "paused"],
      default: "active",
      index: true,
    },

    cadence: {
      type: String,
      required: true,
      enum: ["daily", "weekly"],
      default: "daily",
    },

    targetCount: { type: Number, required: true, min: 1, default: 1 },
    targetAmount: { type: Number, required: false, min: 0 },
    unit: {
      type: String,
      required: true,
      enum: ["minutes", "hours", "steps", "cups", "oz", "ml", "pages", "count", "sessions"],
      default: "sessions",
    },

    timezone: { type: String, required: true },

    reminderSchedule: {
      type: HabitReminderScheduleSchema,
      required: true,
      default: () => ({ kind: "off" }),
    },

    nextReminderAt: { type: Date, required: false, index: true },
    lastRemindedAt: { type: Date, required: false },

    // ✅ lock belongs HERE (inside the schema fields)
    lock: { type: HabitLockSchema, required: false, default: undefined },
  },
  { timestamps: true }
);

// Polling index for habit reminders
HabitSchema.index({ status: 1, nextReminderAt: 1 });

export const Habit: Model<HabitDoc> =
  (mongoose.models.Habit as Model<HabitDoc>) ||
  mongoose.model<HabitDoc>("Habit", HabitSchema);