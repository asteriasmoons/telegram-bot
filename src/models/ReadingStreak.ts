import { Schema, model, Document } from "mongoose";

export interface ReadingStreakDoc extends Document {
  userId: number;
  currentStreak: number;
  bestStreak: number;
  lastCheckInDate: string | null; // "YYYY-MM-DD" in user's timezone
  createdAt: Date;
  updatedAt: Date;
}

const ReadingStreakSchema = new Schema<ReadingStreakDoc>(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    currentStreak: { type: Number, required: true, default: 0 },
    bestStreak: { type: Number, required: true, default: 0 },
    lastCheckInDate: { type: String, required: false, default: null },
  },
  { timestamps: true }
);

export const ReadingStreak = model<ReadingStreakDoc>("ReadingStreak", ReadingStreakSchema);