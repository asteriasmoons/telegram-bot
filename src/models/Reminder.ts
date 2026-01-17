import mongoose, { Schema, Model, Types } from "mongoose";

export type ReminderStatus = "scheduled" | "sent" | "paused" | "deleted";

export type ReminderScheduleKind = "once" | "daily" | "weekly" | "interval";

export type ReminderSchedule = {
kind: ReminderScheduleKind;

// For daily/weekly schedules
timeOfDay?: string; // "HH:MM" 24-hour, user-local time
daysOfWeek?: number[]; // 0-6 (Sun-Sat) if weekly

// For interval schedules
intervalMinutes?: number;
};

export type ReminderLock = {
lockedAt?: Date;
lockExpiresAt?: Date;
lockedBy?: string;
};

/**

- Telegram message entities (minimal shape).
- We store them as plain objects so Telegraf/Telegram can re-use them on send.
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

status: ReminderStatus;

// Scheduler field
nextRunAt: Date;

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
kind: { type: String, required: true, enum: ["once", "daily", "weekly", "interval"] },
timeOfDay: { type: String, required: false },
daysOfWeek: { type: [Number], required: false },
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