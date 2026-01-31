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
  | "sessions"; // useful for habits where "just did it" is the measure

export type HabitCadence = "daily" | "weekly";

/**
 * Habit reminder schedule is about nudging you to DO the habit,
 * not about logging the completion itself.
 *
 * We keep this similar to ReminderSchedule but add "hourly" and "every_x_minutes"
 * because you asked for it.
 */
export type HabitReminderKind =
  | "off"          // no reminders, habit still exists for logging/streaks
  | "times"        // specific times of day: ["09:00","21:00"]
  | "hourly"       // every N hours within a window
  | "every_x_minutes"; // every N minutes within a window

export type HabitReminderSchedule = {
  kind: HabitReminderKind;

  // kind: "times"
  timesOfDay?: string[]; // ["HH:mm", ...]

  // kind: "hourly"
  everyHours?: number; // e.g., 2 => every 2 hours

  // kind: "every_x_minutes"
  everyMinutes?: number; // e.g., 45 => every 45 minutes

  // Optional time window for hourly/minutes
  windowStart?: string; // "HH:mm"
  windowEnd?: string;   // "HH:mm"

  // Optional days restriction (0-6 Sun-Sat)
  daysOfWeek?: number[]; // for weekly rhythms if you ever want it
};

export type HabitDoc = {
  _id: Types.ObjectId;

  userId: number;
  chatId: number;

  name: string;
  description?: string;

  status: HabitStatus;

  // Measurement / goal
  cadence: HabitCadence;        // daily or weekly target
  targetCount: number;          // how many sessions per cadence (e.g., 2 per day)
  targetAmount?: number;        // amount per session (or per day, depending on your UI)
  unit: HabitUnit;

  // Timezone for schedule computation and streak boundaries
  timezone: string;

  // Reminder scheduler fields (separate from Reminder scheduler)
  reminderSchedule: HabitReminderSchedule;
  nextReminderAt?: Date; // next time to send a habit reminder (if reminders are enabled)

  // Execution bookkeeping
  createdAt: Date;
  updatedAt: Date;
  lastRemindedAt?: Date;
  
    lock?: {
    lockedAt?: Date;
    lockExpiresAt?: Date;
    lockedBy?: string;
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

const HabitLockSchema = new Schema(
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

    reminderSchedule: { type: HabitReminderScheduleSchema, required: true, default: () => ({ kind: "off" }) },
    nextReminderAt: { type: Date, required: false, index: true },
    lastRemindedAt: { type: Date, required: false },
  },
  { timestamps: true }
      lock: { type: HabitLockSchema, required: false, default: undefined },
);

// Polling index for habit reminders
HabitSchema.index({ status: 1, nextReminderAt: 1 });

export const Habit: Model<HabitDoc> =
  (mongoose.models.Habit as Model<HabitDoc>) ||
  mongoose.model<HabitDoc>("Habit", HabitSchema);