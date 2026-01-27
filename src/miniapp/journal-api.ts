// src/miniapp/journal-api.ts
// Journal API endpoints for the Telegram Mini App

import { Router } from "express";
import { JournalEntry } from "../models/JournalEntry";
import { Premium } from "../models/Premium";

import { claimDailyPrompt } from "../services/promptQuota";
import { generateJournalPrompt } from "../services/groq";

const router = Router();

/**
 * =========================================================
 * JOURNAL CAPS CONFIG
 * =========================================================
 */

// CHANGE THIS to whatever free cap you want
const FREE_JOURNAL_LIMIT = 5;

/**
 * CAP BYPASS (OWNER / ADMIN)
 * Add your Telegram user ID(s) here to bypass caps entirely.
 * Example userId is the one you've shown in your data before.
 */
  const CAP_BYPASS_USER_IDS = new Set<number>([
 6382917923, // <-- replace/confirm this is YOUR Telegram user id
]);

/**
 * Helper: is user premium right now?
 */
async function isPremiumActive(userId: number) {
  const now = new Date();

  const doc = await Premium.findOne({
    userId,
    isActive: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  }).lean();

  return !!doc;
}

/**
 * Helper: count user's journal entries
 */
async function countJournalEntries(userId: number) {
  return JournalEntry.countDocuments({ userId });
}

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

// GET /api/miniapp/journal/tags
// Returns a list of { name, count } for the user's tags
router.get("/tags", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const tags = await JournalEntry.aggregate([
      { $match: { userId } },
      { $unwind: "$tags" },
      {
        $group: {
          _id: "$tags",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          name: "$_id",
          count: 1,
        },
      },
    ]);

    res.json({ tags });
  } catch (error) {
    console.error("Error fetching journal tags:", error);
    res.status(500).json({ error: "Failed to fetch journal tags" });
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

    /**
     * =========================================================
     * CAPS ENFORCEMENT (WITH BYPASS)
     * =========================================================
     *
     * Rules:
     * - If userId is in CAP_BYPASS_USER_IDS => ignore caps.
     * - Else if Premium is active => unlimited.
     * - Else (free user) => cap at FREE_JOURNAL_LIMIT total entries.
     */
    const bypassCaps = CAP_BYPASS_USER_IDS.has(userId);

    if (!bypassCaps) {
      const premiumActive = await isPremiumActive(userId);

      if (!premiumActive) {
        const currentCount = await countJournalEntries(userId);

        if (currentCount >= FREE_JOURNAL_LIMIT) {
          return res.status(403).json({
            error: "JOURNAL_LIMIT_REACHED",
            message: `Free users can create up to ${FREE_JOURNAL_LIMIT} journal entries. Upgrade to Premium for unlimited journals.`,
            limit: FREE_JOURNAL_LIMIT,
            current: currentCount,
          });
        }
      }
    }

    // DM-only journaling right now:
    // We store chatId as the user's DM chat id.
    // The Mini App might not know DM chat id, so we store chatId as userId for now
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

// POST /api/miniapp/journal/prompt
router.post("/prompt", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const quota = await claimDailyPrompt(userId);

    if (!quota.allowed) {
      return res.status(429).json({
        error: "DAILY_PROMPT_LIMIT_REACHED",
        message: "You’ve used your 2 prompts for today. Try again tomorrow.",
        remaining: quota.remaining,
        dateKey: quota.dateKey,
      });
    }

    const prompt = await generateJournalPrompt();

    return res.json({
      prompt,
      remaining: quota.remaining,
      dateKey: quota.dateKey,
    });
  } catch (error) {
    console.error("Error generating journal prompt:", error);
    return res.status(500).json({ error: "Failed to generate prompt" });
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