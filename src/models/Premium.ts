// src/models/Premium.ts
import mongoose, { Schema } from "mongoose";

export type PremiumDoc = mongoose.Document & {
  userId: number;
  isActive: boolean;
  expiresAt?: Date | null;

  // Optional bookkeeping
  plan?: string; // e.g. "premium_30d"
  lastPurchaseAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
};

const PremiumSchema = new Schema<PremiumDoc>(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    isActive: { type: Boolean, default: false, index: true },
    expiresAt: { type: Date, default: null, index: true },

    plan: { type: String, default: "" },
    lastPurchaseAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Helpful index for cleanup/queries (optional)
PremiumSchema.index({ expiresAt: 1 });

export const Premium =
  mongoose.models.Premium || mongoose.model<PremiumDoc>("Premium", PremiumSchema);