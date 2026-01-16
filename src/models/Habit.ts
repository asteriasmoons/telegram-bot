import mongoose, { Schema, Model, Types } from "mongoose";

export type HabitStatus = "active" | "paused" | "deleted";

export type HabitScheduleKind = "daily" | "weekly" | "interval";

export type HabitSchedule = {
  kind: HabitScheduleKind;

  // Daily/Weekly
  timeOfDay?: string; // "HH:MM"
  daysOfWeek?: number[]; // 0-6 (Sun-Sat) if weekly

  // Interval
  intervalMinutes?: number;
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

  timezone: string;

  // Scheduler field
  nextRunAt: Date;

  schedule: HabitSchedule;

  // Execution bookkeeping
  createdAt: Date;
  updatedAt: Date;
  lastRunAt?: Date;

  // Locking for multi-process safety
  lock?: HabitLock;
};

const HabitScheduleSchema = new Schema<HabitSchedule>(
  {
    kind: { type: String, required: true, enum: ["daily", "weekly", "interval"] },
    timeOfDay: { type: String, required: false },
    daysOfWeek: { type: [Number], required: false },
    intervalMinutes: { type: Number, required: false }
  },
  { _id: false }
);

const HabitLockSchema = new Schema<HabitLock>(
  {
    lockedAt: { type: Date, required: false },
    lockExpiresAt: { type: Date, required: false },
    lockedBy: { type: String, required: false }
  },
  { _id: false }
);

const HabitSchema = new Schema<HabitDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true, index: true },

    name: { type: String, required: true },
    description: { type: String, required: false },

    status: { type: String, required: true, enum: ["active", "paused", "deleted"], default: "active" },

    timezone: { type: String, required: true },

    nextRunAt: { type: Date, required: true, index: true },

    schedule: { type: HabitScheduleSchema, required: true },

    lastRunAt: { type: Date, required: false },

    lock: { type: HabitLockSchema, required: false, default: () => ({}) }
  },
  { timestamps: true }
);

HabitSchema.index({ status: 1, nextRunAt: 1 });
HabitSchema.index({ "lock.lockExpiresAt": 1 });

export const Habit: Model<HabitDoc> =
  (mongoose.models.Habit as Model<HabitDoc>) ||
  mongoose.model<HabitDoc>("Habit", HabitSchema);