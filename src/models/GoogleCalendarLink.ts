import mongoose, { Schema, Model } from "mongoose";

export type GoogleCalendarLinkDoc = {
  userId: number;

  // OAuth tokens
  refreshToken: string;            // persist this (required for offline access)
  accessToken?: string | null;     // optional cache
  expiryDate?: number | null;      // ms epoch

  // which calendar to write into (default primary)
  calendarId: string;

  createdAt: Date;
  updatedAt: Date;
};

const GoogleCalendarLinkSchema = new Schema<GoogleCalendarLinkDoc>(
  {
    userId: { type: Number, required: true, unique: true, index: true },

    refreshToken: { type: String, required: true },
    accessToken: { type: String, required: false, default: null },
    expiryDate: { type: Number, required: false, default: null },

    calendarId: { type: String, required: true, default: "primary" },
  },
  { timestamps: true }
);

export const GoogleCalendarLink: Model<GoogleCalendarLinkDoc> =
  (mongoose.models.GoogleCalendarLink as Model<GoogleCalendarLinkDoc>) ||
  mongoose.model<GoogleCalendarLinkDoc>("GoogleCalendarLink", GoogleCalendarLinkSchema);