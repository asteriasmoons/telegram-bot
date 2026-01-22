import mongoose, { Schema } from "mongoose";

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

    tags: { type: [String], default: [], index: true },

    entities: { type: Array, default: [] }
  },
  { timestamps: true }
);

JournalEntrySchema.index({ userId: 1, createdAt: -1 });

export const JournalEntry =
  mongoose.models.JournalEntry ||
  mongoose.model<JournalEntryDoc>("JournalEntry", JournalEntrySchema);