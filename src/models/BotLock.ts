import mongoose, { Schema, Model } from "mongoose";

export type BotLockDoc = {
  key: string;            // e.g. "telegram_polling_lock"
  lockedBy: string;       // instance id
  lockExpiresAt: Date;    // lease expiry
  createdAt: Date;
  updatedAt: Date;
};

const BotLockSchema = new Schema<BotLockDoc>(
  {
    key: { type: String, required: true, unique: true, index: true },
    lockedBy: { type: String, required: true },
    lockExpiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

export const BotLock: Model<BotLockDoc> =
  (mongoose.models.BotLock as Model<BotLockDoc>) ||
  mongoose.model<BotLockDoc>("BotLock", BotLockSchema);