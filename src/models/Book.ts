import mongoose, { Schema, InferSchemaType } from "mongoose";

const BookSchema = new Schema(
  {
    userId: { type: Number, required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    author: { type: String, default: "", trim: true, maxlength: 200 },

    // NEW: short card summary (1–2 sentences)
    shortSummary: { type: String, default: "", trim: true, maxlength: 800 },
    
    // Rating: 0–5 stars (0 = none)
rating: {
  type: Number,
  default: 0,
  min: 0,
  max: 5,
},

    // Only 3 statuses, exactly as requested
    status: {
      type: String,
      required: true,
      enum: ["tbr", "reading", "finished", "paused", "dnf"],
      default: "tbr",
      index: true,
    },

    // ---- Progress (only meaningful for "reading") ----
    totalPages: { type: Number, default: null, min: 0 },
    currentPage: { type: Number, default: null, min: 0 },
  },
  { timestamps: true }
);

// Helpful index for common queries (user + status + newest)
BookSchema.index({ userId: 1, status: 1, createdAt: -1 });

export type BookDoc = InferSchemaType<typeof BookSchema>;

export const Book =
  (mongoose.models.Book as mongoose.Model<BookDoc>) ||
  mongoose.model<BookDoc>("Book", BookSchema);