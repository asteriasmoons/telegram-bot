// src/models/MoodLog.ts

import mongoose, { Schema, type Model, type Types } from "mongoose";

// ✅ Single source of truth for mood values
export const MOOD_VALUES = [
  "amazing",
  "happy",
  "good",
  "okay",
  "meh",
  "sad",
  "anxious",
  "stressed",
  "angry",
  "tired",
  "sick",
  "depressed",
  "grateful",
  "excited",
  "calm",
  "frustrated",
  "lonely",
  "hopeful",
  "overwhelmed",
  "content",
] as const;

export type MoodValue = (typeof MOOD_VALUES)[number];

// ✅ Single source of truth for activities
export const MOOD_ACTIVITIES = [
  "work",
  "exercise",
  "reading",
  "cooking",
  "socializing",
  "gaming",
  "meditation",
  "walking",
  "shopping",
  "cleaning",
  "studying",
  "journaling",
  "music",
  "movies",
  "family",
  "pets",
  "nature",
  "creative",
  "rest",
  "travel",
  "therapy",
  "yoga",
  "self-care",
  "errands",
  "date",
] as const;

export type MoodActivity = (typeof MOOD_ACTIVITIES)[number];

// ✅ Mood score mapping (used for the progress bar / sentiment calculation)
// Higher = more positive. Scale: 1 (worst) to 5 (best).
export const MOOD_SCORES: Record<MoodValue, number> = {
  amazing: 5,
  excited: 5,
  happy: 4.5,
  grateful: 4.5,
  good: 4,
  hopeful: 4,
  calm: 3.8,
  content: 3.5,
  okay: 3,
  meh: 2.5,
  tired: 2.2,
  frustrated: 2,
  stressed: 2,
  anxious: 2,
  overwhelmed: 1.8,
  lonely: 1.5,
  sad: 1.5,
  angry: 1.5,
  sick: 1.2,
  depressed: 1,
};

export type MoodLogDoc = {
  _id: Types.ObjectId;

  userId: number;

  // The moods selected (1 or more)
  moods: MoodValue[];

  // The activities selected (0 or more)
  activities: MoodActivity[];

  // Optional note
  note?: string;

  // Computed average mood score (1–5) at creation time
  score: number;

  createdAt: Date;
  updatedAt: Date;
};

const MoodLogSchema = new Schema<MoodLogDoc>(
  {
    userId: { type: Number, required: true, index: true },

    moods: {
      type: [String],
      required: true,
      validate: {
        validator: (v: string[]) => Array.isArray(v) && v.length > 0,
        message: "At least one mood is required",
      },
      enum: MOOD_VALUES,
    },

    activities: {
      type: [String],
      required: false,
      default: [],
      enum: MOOD_ACTIVITIES,
    },

    note: { type: String, required: false, trim: true, maxlength: 500 },

    score: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

// Common queries: latest logs, logs within a date range
MoodLogSchema.index({ userId: 1, createdAt: -1 });

export const MoodLog: Model<MoodLogDoc> =
  (mongoose.models.MoodLog as Model<MoodLogDoc>) ||
  mongoose.model<MoodLogDoc>("MoodLog", MoodLogSchema);