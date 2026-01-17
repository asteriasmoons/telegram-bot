import mongoose, { Schema, Model, Types } from "mongoose";

/* ––––––––––––––
Draft core types
------------------– */

export type DraftKind = "reminder" | "habit" | "reminder_edit";

export type DraftStep =
| "choose_time"
| "choose_repeat"
| "enter_text"
| "confirm"
| "edit"
| "done";

/* ––––––––––––––
Reminder create draft types
------------------– */

export type ReminderDraftAwaiting = "date" | "time" | "interval" | "message";

export type ReminderDraftData = {
dateISO?: string;        // YYYY-MM-DD
timeHHMM?: string;       // HH:MM

text?: string;           // reminder message (you can include title + body)
entities?: any[];        // Telegram entities for custom emojis and formatting

repeatKind?: "none" | "daily" | "weekly" | "interval";
daysOfWeek?: number[];   // Sun=0..Sat=6 (future-safe)
intervalMinutes?: number;

awaiting?: ReminderDraftAwaiting;
};

/* ––––––––––––––
Habit draft types (future-safe)
------------------– */

export type HabitDraftData = {
name?: string;
description?: string;
scheduleKind?: "daily" | "weekly" | "interval";
timeOfDay?: string;      // HH:MM
daysOfWeek?: number[];
intervalMinutes?: number;
nextRunAt?: Date;
};

/* ––––––––––––––
Reminder edit draft types
------------------– */

export type ReminderEditDraft = {
awaiting?: ReminderDraftAwaiting; // what typed input we are waiting for
editMode?: "none" | "message" | "date" | "time" | "frequency";
stagedText?: string;              // staged new message before save
stagedEntities?: any[];           // staged entities before save
};

/* ––––––––––––––
Draft document type
------------------– */

export type DraftDoc = {
_id: Types.ObjectId;

userId: number;
chatId: number;

kind: DraftKind;
step: DraftStep;

timezone: string;

// create drafts
reminder?: ReminderDraftData;
habit?: HabitDraftData;

// edit drafts
targetReminderId?: string;
page?: number;
edit?: ReminderEditDraft;

// TTL cleanup
expiresAt: Date;

createdAt: Date;
updatedAt: Date;
};

/* ––––––––––––––
Schemas
------------------– */

const ReminderDraftSchema = new Schema<ReminderDraftData>(
{
dateISO: { type: String },
timeHHMM: { type: String },


text: { type: String },
entities: { type: [Schema.Types.Mixed] },

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

const ReminderEditDraftSchema = new Schema<ReminderEditDraft>(
{
awaiting: {
type: String,
enum: ["date", "time", "interval", "message"]
},
editMode: {
type: String,
enum: ["none", "message", "date", "time", "frequency"]
},
stagedText: { type: String },
stagedEntities: { type: [Schema.Types.Mixed] }
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
  enum: ["reminder", "habit", "reminder_edit"],
  index: true
},

step: { type: String, required: true },

timezone: { type: String, required: true },

reminder: { type: ReminderDraftSchema },
habit: { type: HabitDraftSchema },

targetReminderId: { type: String },
page: { type: Number },
edit: { type: ReminderEditDraftSchema },

expiresAt: { type: Date, required: true }


},
{ timestamps: true }
);

/* ––––––––––––––
Indexes
------------------– */

// TTL index: documents expire automatically
DraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Helpful lookup
DraftSchema.index({ userId: 1, kind: 1 });

/* ––––––––––––––
Model export
------------------– */

export const Draft: Model<DraftDoc> =
(mongoose.models.Draft as Model<DraftDoc>) ||
mongoose.model<DraftDoc>("Draft", DraftSchema);