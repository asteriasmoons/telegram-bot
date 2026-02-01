// src/models/HabitLog.ts

import mongoose, { Schema, Model, Types } from "mongoose";
import { HABIT_UNITS, type HabitUnit } from "./Habit";

export type HabitLogDoc = {
  _id: Types.ObjectId;

  userId: number;
  habitId: Types.ObjectId;

  // When did it happen (used for period boundaries)
  startedAt: Date;
  endedAt?: Date;

  // What happened
  amount?: number;
  unit: HabitUnit;

  // Optional note if you ever want it later (you can omit in UI)
  note?: string;

  createdAt: Date;
  updatedAt: Date;
};

const HabitLogSchema = new Schema<HabitLogDoc>(
  {
    userId: { type: Number, required: true, index: true },
    habitId: { type: Schema.Types.ObjectId, required: true, ref: "Habit", index: true },

    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, required: false },

    amount: { type: Number, required: false, min: 0 },
    unit: {
      type: String,
      required: true,
      enum: HABIT_UNITS, // ✅ shared with Habit schema
      default: "sessions",
    },

    note: { type: String, required: false, trim: true },
  },
  { timestamps: true }
);

// Common queries:
// - logs for a habit (latest first)
// - logs within a date range to compute daily/weekly completion
HabitLogSchema.index({ habitId: 1, startedAt: -1 });
HabitLogSchema.index({ userId: 1, startedAt: -1 });

export const HabitLog: Model<HabitLogDoc> =
  (mongoose.models.HabitLog as Model<HabitLogDoc>) ||
  mongoose.model<HabitLogDoc>("HabitLog", HabitLogSchema);