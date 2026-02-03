// src/miniapp/checklist-api.ts
// Simple checklist/todo API

import { Router } from "express";
import { ChecklistItem } from "../models/ChecklistItem";

const router = Router();

// GET /checklist - List all checklist items
router.get("/", async (req, res) => {
  try {
    const items = await ChecklistItem.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    console.error("Error fetching checklist:", error);
    res.status(500).json({ error: "Failed to fetch checklist" });
  }
});

// POST /checklist - Create new item
router.post("/", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text required" });
    }

    const item = await ChecklistItem.create({
      userId: req.userId,
      text: text.trim(),
      done: false
    });

    res.json({ item });
  } catch (error) {
    console.error("Error creating checklist item:", error);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// PUT /checklist/:id - Update item text
router.put("/:id", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text required" });
    }

    const item = await ChecklistItem.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { text: text.trim() } },
      { new: true }
    ).lean();

    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json({ item });
  } catch (error) {
    console.error("Error updating checklist item:", error);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// POST /checklist/:id/toggle - Toggle done status
router.post("/:id/toggle", async (req, res) => {
  try {
    const current = await ChecklistItem.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!current) {
      return res.status(404).json({ error: "Item not found" });
    }

    const item = await ChecklistItem.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { done: !current.done } },
      { new: true }
    ).lean();

    res.json({ item });
  } catch (error) {
    console.error("Error toggling checklist item:", error);
    res.status(500).json({ error: "Failed to toggle item" });
  }
});

// DELETE /checklist/:id - Delete item
router.delete("/:id", async (req, res) => {
  try {
    const item = await ChecklistItem.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json({ item });
  } catch (error) {
    console.error("Error deleting checklist item:", error);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

export default router;

// Type augmentation for Express Request
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}
