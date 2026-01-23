import { Schema, model, Document } from "mongoose";

export interface DailyPromptUsageDoc extends Document {
  userId: number;
  dateKey: string; // YYYY-MM-DD in America/Chicago
  count: number;   // 0..2
  updatedAt: Date;
}

const DailyPromptUsageSchema = new Schema<DailyPromptUsageDoc>(
  {
    userId: { type: Number, required: true, index: true },
    dateKey: { type: String, required: true, index: true },
    count: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

// Enforce one row per user per day
DailyPromptUsageSchema.index({ userId: 1, dateKey: 1 }, { unique: true });

export const DailyPromptUsage = model<DailyPromptUsageDoc>(
  "DailyPromptUsage",
  DailyPromptUsageSchema
);