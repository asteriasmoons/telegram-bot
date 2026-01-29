// src/models/Draft.ts
import mongoose, { Schema, Model, Types } from "mongoose";

/* ––––––––––––––
Draft core types
------------------– */

export type DraftKind =
  | "reminder"
  | "habit"
  | "reminder_edit"
  | "journal"
  | "journal_edit";

export type DraftStep =
  | "choose_time"
  | "choose_repeat"
  | "enter_text"
  | "confirm"
  | "edit"
  | "done"
  | "panel";

/* ––––––––––––––
Reminder create draft types
------------------– */

export type ReminderDraftAwaiting = "date" | "time" | "interval" | "message";

export type ReminderDraftData = {
  dateISO?: string; // YYYY-MM-DD
  timeHHMM?: string; // HH:MM

  text?: string; // reminder message (you can include title + body)
  entities?: any[]; // Telegram entities for custom emojis and formatting

  repeatKind?: "none" | "daily" | "weekly" | "interval";
  daysOfWeek?: number[]; // Sun=0..Sat=6 (future-safe)
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
  timeOfDay?: string; // HH:MM
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
  stagedText?: string; // staged new message before save
  stagedEntities?: any[]; // staged entities before save
};

/* ––––––––––––––
Journal draft types
------------------– */

export type JournalDraftAwaiting = "title" | "body" | "tags";

export type JournalDraftData = {
  title?: string;
  body?: string;
  tags?: string[];
  entities?: any[];
  awaiting?: JournalDraftAwaiting;
};

export type JournalEditDraft = {
  awaiting?: JournalDraftAwaiting;
  stagedTitle?: string;
  stagedBody?: string;
  stagedTags?: string[];
  stagedEntities?: any[];
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
  panelMessageId?: number;

  // create drafts
  reminder?: ReminderDraftData;
  habit?: HabitDraftData;

  // journal create draft
  entry?: JournalDraftData; // (kept compatible with your journal.ts which uses d.entry)

  // edit drafts
  targetReminderId?: string;
  page?: number;
  edit?: ReminderEditDraft;

  // journal edit draft
  targetJournalId?: string;
  journalEdit?: JournalEditDraft;

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
      enum: ["none", "daily", "weekly", "interval"],
    },

    daysOfWeek: { type: [Number] },

    intervalMinutes: { type: Number },

    awaiting: {
      type: String,
      enum: ["date", "time", "interval", "message"],
    },
  },
  { _id: false }
);

const HabitDraftSchema = new Schema<HabitDraftData>(
  {
    name: { type: String },
    description: { type: String },
    scheduleKind: {
      type: String,
      enum: ["daily", "weekly", "interval"],
    },
    timeOfDay: { type: String },
    daysOfWeek: { type: [Number] },
    intervalMinutes: { type: Number },
    nextRunAt: { type: Date },
  },
  { _id: false }
);

const ReminderEditDraftSchema = new Schema<ReminderEditDraft>(
  {
    awaiting: {
      type: String,
      enum: ["date", "time", "interval", "message"],
    },
    editMode: {
      type: String,
      enum: ["none", "message", "date", "time", "frequency"],
    },
    stagedText: { type: String },
    stagedEntities: { type: [Schema.Types.Mixed] },
  },
  { _id: false }
);

const JournalDraftSchema = new Schema<JournalDraftData>(
  {
    title: { type: String },
    body: { type: String },
    tags: { type: [String] },
    entities: { type: [Schema.Types.Mixed] },
    awaiting: { type: String, enum: ["title", "body", "tags"] },
  },
  { _id: false }
);

const JournalEditDraftSchema = new Schema<JournalEditDraft>(
  {
    awaiting: { type: String, enum: ["title", "body", "tags"] },
    stagedTitle: { type: String },
    stagedBody: { type: String },
    stagedTags: { type: [String] },
    stagedEntities: { type: [Schema.Types.Mixed] },
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
      enum: ["reminder", "habit", "reminder_edit", "journal", "journal_edit"],
      index: true,
    },

    step: { type: String, required: true },

    timezone: { type: String, required: true },
        // ✅ control panel message id
    panelMessageId: { type: Number, required: false },

    // create drafts
    reminder: { type: ReminderDraftSchema },
    habit: { type: HabitDraftSchema },

    // journal create draft (your journal.ts uses d.entry)
    entry: { type: JournalDraftSchema },

    // reminder edit draft
    targetReminderId: { type: String },
    page: { type: Number },
    edit: { type: ReminderEditDraftSchema },

    // journal edit draft
    targetJournalId: { type: String },
    journalEdit: { type: JournalEditDraftSchema },

    // TTL cleanup
    expiresAt: { type: Date, required: true },
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