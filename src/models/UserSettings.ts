import mongoose, { Schema, Model } from "mongoose";

export type QuietHours = {
  enabled: boolean;
  start: string; // "HH:MM" 24-hour
  end: string;   // "HH:MM" 24-hour
};

export type UserSettingsDoc = {
  userId: number; // Telegram user id
  dmChatId?: number; // Telegram private chat id with bot (needed for DM delivery)
  timezone: string; // IANA timezone, e.g. "America/Chicago"
  displayName?: string; // NEW: user-chosen display name (shown in UI)
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
    dmChatId: { type: Number, required: false, index: true },

    timezone: { type: String, required: true, default: "America/Chicago" },

    // NEW: Display Name
    displayName: {
      type: String,
      required: false,
      default: "",
      trim: true,
      maxlength: 48,
    },

    quietHours: { type: QuietHoursSchema, required: true, default: () => ({}) }
  },
  { timestamps: true }
);

export const UserSettings: Model<UserSettingsDoc> =
  (mongoose.models.UserSettings as Model<UserSettingsDoc>) ||
  mongoose.model<UserSettingsDoc>("UserSettings", UserSettingsSchema);