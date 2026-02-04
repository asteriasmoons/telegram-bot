import mongoose, { Schema, Document } from 'mongoose';

export interface Intention extends Document {
  userId: string;
  text: string;
  setAt: Date;
  updatedAt: Date;
}

const IntentionSchema = new Schema<Intention>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    setAt: {
      type: Date,
      required: true,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Compound index for efficient querying
IntentionSchema.index({ userId: 1, setAt: -1 });

export default mongoose.model<Intention>('Intention', IntentionSchema);
