// src/models/ChecklistItem.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IChecklistItem extends Document {
  userId: number;
  text: string;
  done: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const checklistItemSchema = new Schema<IChecklistItem>(
  {
    userId: {
      type: Number,
      required: true,
      index: true
    },
    text: {
      type: String,
      required: true
    },
    done: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

export const ChecklistItem = mongoose.model<IChecklistItem>("ChecklistItem", checklistItemSchema);
