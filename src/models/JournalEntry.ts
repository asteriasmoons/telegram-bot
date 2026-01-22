// src/models/JournalEntry.ts
import mongoose, { Schema, Model } from "mongoose";

export type JournalEntryDoc = mongoose.Document & {
  userId: number;
  chatId: number;

  title?: string;
  body: string;

  // Stored WITHOUT the leading #
  tags: string[];

  // Optional: preserves custom emoji + formatting if you ever use entities
  entities?: any[];

  createdAt: Date;
  updatedAt: Date;
};

const JournalEntrySchema = new Schema<JournalEntryDoc>(
  {
    userId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true },

    title: { type: String, default: "" },
    body: { type: String, required: true },

    // Multikey array of strings
    tags: { type: [String], default: [] },

    // Store Telegram entities safely (custom emoji, formatting, etc.)
    entities: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

// Common query pattern: "give me my newest entries"
JournalEntrySchema.index({ userId: 1, createdAt: -1 });

// Common query pattern: "filter my entries by tag"
JournalEntrySchema.index({ userId: 1, tags: 1 });

export const JournalEntry: Model<JournalEntryDoc> =
  (mongoose.models.JournalEntry as Model<JournalEntryDoc>) ||
  mongoose.model<JournalEntryDoc>("JournalEntry", JournalEntrySchema);