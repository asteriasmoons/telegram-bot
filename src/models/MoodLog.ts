// src/models/MoodLog.ts

import mongoose, { Schema, type Model, type Types } from "mongoose";

// ✅ Single source of truth for mood values
export const MOOD_VALUES = [
  "happy",
  "content",
  "inspired",
  "productive",
  "loved",
  "grateful",
  "optimistic",
  "confident",
  "motivated",
  "amused",
  "sad",
  "irritated",
  "disappointed",
  "angry",
  "cynical",
  "insecure",
  "overwhelmed",
  "stressed",
  "scared",
  "confused",
  "reflective",
  "distracted",
  "lonely",
  "discouraged",
  "good",
  "okay",
  "neutral",
] as const;

export type MoodValue = (typeof MOOD_VALUES)[number];

// ✅ Single source of truth for activities
export const MOOD_ACTIVITIES = [
  "friends",
  "family",
  "community",
  "dating",

  "hobby",
  "creative",
  "work",
  "education",
  "reading",

  "hygiene",
  "fitness",
  "health",
  "self-care",
  "mindfulness",

  "chores",
  "errands",
  "shopping",
  "baking",

  "pets",
  "nature",

  "journaling",
  "spirituality",
  "religion",

  "entertainment",
  "social-media",
  "tech",
] as const;

export type MoodActivity = (typeof MOOD_ACTIVITIES)[number];

// ✅ Mood score mapping (used for the progress bar / sentiment calculation)
// Higher = more positive. Scale: 1 (worst) to 5 (best).
export const MOOD_SCORES: Record<MoodValue, number> = {
  happy: 4.3,
  content: 3.8,
  inspired: 4.2,
  productive: 4.1,
  loved: 4.4,
  grateful: 4.4,
  optimistic: 4.0,
  confident: 4.0,
  motivated: 4.0,
  amused: 3.9,

  good: 3.6,
  okay: 3.0,
  neutral: 3.0,
  reflective: 3.2,
  distracted: 2.7,
  confused: 2.6,

  sad: 1.8,
  irritated: 2.0,
  disappointed: 1.9,
  angry: 1.7,
  cynical: 2.0,
  insecure: 1.9,
  overwhelmed: 1.6,
  stressed: 1.7,
  scared: 1.6,
  lonely: 1.7,
  discouraged: 1.8,
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

    note: { type: String, required: false, trim: true, maxlength: 1500 },

    score: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

// Common queries: latest logs, logs within a date range
MoodLogSchema.index({ userId: 1, createdAt: -1 });

export const MoodLog: Model<MoodLogDoc> =
  (mongoose.models.MoodLog as Model<MoodLogDoc>) ||
  mongoose.model<MoodLogDoc>("MoodLog", MoodLogSchema);