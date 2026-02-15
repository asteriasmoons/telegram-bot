import mongoose, { Schema, Model, Types } from "mongoose";

export type ReminderStatus = "scheduled" | "sent" | "paused" | "deleted";

export type ReminderScheduleKind = "once" | "daily" | "weekly" | "monthly" | "yearly" | "interval";

export type ReminderSchedule = {
  kind: ReminderScheduleKind;

  // For daily/weekly/monthly/yearly schedules
  timeOfDay?: string;       // "HH:mm" 24-hour, user-local time
  
  timesOfDay?: string[];
  
  interval?: number;        // every X days/weeks/months/years (>= 1)

  // Weekly only
  daysOfWeek?: number[];    // 0-6 (Sun-Sat)

  // Monthly only
  dayOfMonth?: number; // 1-31 (clamped by scheduler)

  // Yearly only
  anchorMonth?: number;     // 1-12
  anchorDay?: number;       // 1-31 (clamped by scheduler)

  // Interval only
  intervalMinutes?: number;
};

export type ReminderLock = {
  lockedAt?: Date;
  lockExpiresAt?: Date;
  lockedBy?: string;
};

/**
 * Telegram message entities (minimal shape).
 * We store them as plain objects so Telegraf/Telegram can re-use them on send.
 */
export type TgEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: any;
  language?: string;
  custom_emoji_id?: string;
};

export type ReminderDoc = {
  _id: Types.ObjectId;

  userId: number; // Telegram user id
  chatId: number; // Telegram chat id where reminder is sent

  text: string;

  // NEW: preserve Telegram entities so custom emojis survive DB storage.
  entities?: TgEntity[];

  runDayKey?: string;       // e.g. "2026-02-05" in the reminder's timezone
  sentTimesOfDay?: string[]; // e.g. ["09:00","14:00"]

  status: ReminderStatus;

  // Scheduler field
  nextRunAt: Date;
  
    // For one-time reminders: keep visible as DUE NOW until user acknowledges
  acknowledgedAt?: Date | null;

  // Pre-computed next run for recurring reminders (set on fire, consumed on Done)
  pendingNextRunAt?: Date;

  // Optional schedule metadata (for repeating reminders)
  schedule?: ReminderSchedule;

  timezone: string;

  // Execution bookkeeping
  createdAt: Date;
  updatedAt: Date;
  lastRunAt?: Date;

  // Locking for multi-process safety
  lock?: ReminderLock;
};

const ReminderScheduleSchema = new Schema<ReminderSchedule>(
  {
    kind: {
      type: String,
      required: true,
      enum: ["once", "daily", "weekly", "monthly", "yearly", "interval"]
    },

    // for daily/weekly/monthly/yearly
    timeOfDay: { type: String, required: false }, // "HH:mm"
    
    timesOfDay: { type: [String], required: false, default: [] },
    
    interval: { type: Number, required: false, min: 1, default: 1 },

    // weekly only
    daysOfWeek: { type: [Number], required: false, default: [] },

    // monthly only
    dayOfMonth: { type: Number, required: false },

    // yearly only
    anchorMonth: { type: Number, required: false },
    anchorDay: { type: Number, required: false },

    // interval only
    intervalMinutes: { type: Number, required: false }
  },
  { _id: false }
);

const ReminderLockSchema = new Schema<ReminderLock>(
  {
    lockedAt: { type: Date, required: false },
    lockExpiresAt: { type: Date, required: false },
    lockedBy: { type: String, required: false }
  },
  { _id: false }
);

const ReminderSchema = new Schema<ReminderDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true, index: true },
    text: { type: String, required: true },

    // NEW: store entities as plain objects (Mixed) so we don't fight Telegram typing.
    entities: { type: [Schema.Types.Mixed], required: false },

    status: {
      type: String,
      required: true,
      enum: ["scheduled", "sent", "paused", "deleted"],
      default: "scheduled"
    },

    nextRunAt: { type: Date, required: true, index: true },
    
    acknowledgedAt: { type: Date, default: null },

    pendingNextRunAt: { type: Date, required: false },

    runDayKey: { type: String, required: false },
    sentTimesOfDay: { type: [String], required: false, default: [] },

    schedule: { type: ReminderScheduleSchema, required: false },

    timezone: { type: String, required: true },

    lastRunAt: { type: Date, required: false },

    lock: { type: ReminderLockSchema, required: false, default: () => ({}) }
  },
  { timestamps: true }
);

// Helpful compound indexes for polling + filtering
ReminderSchema.index({ status: 1, nextRunAt: 1 });
ReminderSchema.index({ "lock.lockExpiresAt": 1 });

export const Reminder: Model<ReminderDoc> =
  (mongoose.models.Reminder as Model<ReminderDoc>) ||
  mongoose.model<ReminderDoc>("Reminder", ReminderSchema);
