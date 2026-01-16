import mongoose, { Schema, Model } from "mongoose";

export type QuietHours = {
  enabled: boolean;
  start: string; // "HH:MM" 24-hour
  end: string;   // "HH:MM" 24-hour
};

export type UserSettingsDoc = {
  userId: number; // Telegram user id
  timezone: string; // IANA timezone, e.g. "America/Chicago"
  quietHours: QuietHours;
  createdAt: Date;
  updatedAt: Date;
};

const QuietHoursSchema = new Schema<QuietHours>(
  {
    enabled: { type: Boolean, required: true, default: false },
    start: { type: String, required: true, default: "23:00" },
    end: { type: String, required: true, default: "08:00" }
  },
  { _id: false }
);

const UserSettingsSchema = new Schema<UserSettingsDoc>(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    timezone: { type: String, required: true, default: "America/Chicago" },
    quietHours: { type: QuietHoursSchema, required: true, default: () => ({}) }
  },
  { timestamps: true }
);

export const UserSettings: Model<UserSettingsDoc> =
  (mongoose.models.UserSettings as Model<UserSettingsDoc>) ||
  mongoose.model<UserSettingsDoc>("UserSettings", UserSettingsSchema);