// src/miniapp/journal-api.ts
// Journal API endpoints for the Telegram Mini App

import { Router } from "express";
import { JournalEntry } from "../models/JournalEntry";

const router = Router();

function normalizeTags(input: any): string[] {
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t.slice(1) : t))
    .map((t) => t.toLowerCase());

  return Array.from(new Set(cleaned));
}

function clampInt(value: any, def: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// GET /api/miniapp/journal?limit=20&before=ISO&tag=tagname
router.get("/", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const limit = clampInt(req.query.limit, 20, 1, 100);
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const tag = req.query.tag ? String(req.query.tag).trim().toLowerCase() : "";

    const query: any = { userId };

    // Pagination cursor (createdAt < before)
    if (before && !isNaN(before.getTime())) {
      query.createdAt = { $lt: before };
    }

    // Filter by a single tag if provided
    if (tag) {
      query.tags = tag.startsWith("#") ? tag.slice(1) : tag;
    }

    const entries = await JournalEntry.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ entries });
  } catch (error) {
    console.error("Error fetching journal entries:", error);
    res.status(500).json({ error: "Failed to fetch journal entries" });
  }
});

// GET /api/miniapp/journal/:id
router.get("/:id", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const entry = await JournalEntry.findOne({
      _id: req.params.id,
      userId
    }).lean();

    if (!entry) return res.status(404).json({ error: "Journal entry not found" });

    res.json({ entry });
  } catch (error) {
    console.error("Error fetching journal entry:", error);
    res.status(500).json({ error: "Failed to fetch journal entry" });
  }
});

// POST /api/miniapp/journal
router.post("/", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { title, body, tags } = req.body || {};

    const bodyText = String(body || "").trim();
    if (!bodyText) {
      return res.status(400).json({ error: "body is required" });
    }

    const titleText = String(title || "").trim();
    const normalizedTags = normalizeTags(tags);

    // DM-only journaling right now:
    // We store chatId as the user's DM chat id.
    // The Mini App might not know DM chat id, so we store chatId as userId for now
    // (your Telegram userId == DM chatId in most cases; and your bot already uses dmChatId in settings for reminders).
    // If you later want, we can fetch settings.dmChatId here instead.
    const chatId = userId;

    const entry = await JournalEntry.create({
      userId,
      chatId,
      title: titleText,
      body: bodyText,
      tags: normalizedTags,
      entities: [] // mini app doesn’t send entities right now
    });

    res.json({ entry });
  } catch (error) {
    console.error("Error creating journal entry:", error);
    res.status(500).json({ error: "Failed to create journal entry" });
  }
});

// PUT /api/miniapp/journal/:id
router.put("/:id", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { title, body, tags } = req.body || {};

    const update: any = {};

    if (title !== undefined) update.title = String(title || "").trim();
    if (body !== undefined) {
      const b = String(body || "").trim();
      if (!b) return res.status(400).json({ error: "body cannot be empty" });
      update.body = b;
    }
    if (tags !== undefined) update.tags = normalizeTags(tags);

    const entry = await JournalEntry.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: update },
      { new: true }
    ).lean();

    if (!entry) return res.status(404).json({ error: "Journal entry not found" });

    res.json({ entry });
  } catch (error) {
    console.error("Error updating journal entry:", error);
    res.status(500).json({ error: "Failed to update journal entry" });
  }
});

// DELETE /api/miniapp/journal/:id
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const entry = await JournalEntry.findOneAndDelete({
      _id: req.params.id,
      userId
    }).lean();

    if (!entry) return res.status(404).json({ error: "Journal entry not found" });

    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting journal entry:", error);
    res.status(500).json({ error: "Failed to delete journal entry" });
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