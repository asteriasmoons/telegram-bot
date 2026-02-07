// src/miniapp/mood-api.ts

import { Router } from "express";
import mongoose from "mongoose";
import {
  MoodLog,
  MOOD_VALUES,
  MOOD_ACTIVITIES,
  MOOD_SCORES,
} from "../models/MoodLog";
import type { MoodValue } from "../models/MoodLog";

const router = Router();

function isObjectId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  return mongoose.Types.ObjectId.isValid(id);
}

function bad(res: any, message: string, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

/** Compute average mood score from an array of mood strings */
function computeScore(moods: MoodValue[]): number {
  if (!moods || moods.length === 0) return 3; // neutral fallback
  const total = moods.reduce((sum, m) => sum + (MOOD_SCORES[m] ?? 3), 0);
  return Math.round((total / moods.length) * 100) / 100; // 2 decimal places
}

// ─────────────────────────────────────────────
// GET /api/miniapp/mood
// List mood logs (newest first), with optional pagination
// ─────────────────────────────────────────────
router.get("/mood", async (req, res) => {
  try {
    const userId = Number((req as any).userId);

    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const skip = Math.max(0, Number(req.query.skip || 0));

    const q: any = { userId };

    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    if (from && !isNaN(from.getTime()))
      q.createdAt = { ...(q.createdAt || {}), $gte: from };
    if (to && !isNaN(to.getTime()))
      q.createdAt = { ...(q.createdAt || {}), $lte: to };

    const logs = await MoodLog.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ ok: true, logs });
  } catch (e: any) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: e.message || "Failed to list mood logs" });
  }
});

// ─────────────────────────────────────────────
// GET /api/miniapp/mood/options
// Returns available moods + activities
// ─────────────────────────────────────────────
router.get("/mood/options", async (_req, res) => {
  try {
    res.json({
      ok: true,
      moods: [...MOOD_VALUES],
      activities: [...MOOD_ACTIVITIES],
      scores: { ...MOOD_SCORES },
    });
  } catch (e: any) {
    res
      .status(500)
      .json({ ok: false, error: e.message || "Failed to fetch options" });
  }
});

// ─────────────────────────────────────────────
// POST /api/miniapp/mood
// Create a new mood log
// ─────────────────────────────────────────────
router.post("/mood", async (req, res) => {
  try {
    const userId = Number((req as any).userId);
    const { moods, activities, note } = req.body || {};

    if (!Array.isArray(moods) || moods.length === 0) {
      return bad(res, "At least one mood is required");
    }

    const validMoods = moods
      .map((m: any) => String(m || "").toLowerCase().trim())
      .filter((m: string) =>
        (MOOD_VALUES as readonly string[]).includes(m)
      ) as MoodValue[];

    if (validMoods.length === 0) {
      return bad(res, "No valid moods provided");
    }

    const validActivities = Array.isArray(activities)
      ? activities
          .map((a: any) => String(a || "").toLowerCase().trim())
          .filter((a: string) =>
            (MOOD_ACTIVITIES as readonly string[]).includes(a)
          )
      : [];

    const score = computeScore(validMoods);

    const log = await MoodLog.create({
      userId,
      moods: validMoods,
      activities: validActivities,
      note: note ? String(note).trim().slice(0, 500) : undefined,
      score,
    });

    res.json({ ok: true, log: log.toObject() });
  } catch (e: any) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: e.message || "Failed to create mood log" });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/miniapp/mood/:id
// ─────────────────────────────────────────────
router.delete("/mood/:id", async (req, res) => {
  try {
    const userId = Number((req as any).userId);
    const id = String(req.params.id);

    if (!isObjectId(id)) return bad(res, "Invalid mood log id");

    const r = await MoodLog.deleteOne({ _id: id, userId });
    if (r.deletedCount === 0) return bad(res, "Mood log not found", 404);

    res.json({ ok: true });
  } catch (e: any) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: e.message || "Failed to delete mood log" });
  }
});

// ─────────────────────────────────────────────
// GET /api/miniapp/mood/stats
// Returns averages for last 7 & 30 days
// ─────────────────────────────────────────────
router.get("/mood/stats", async (req, res) => {
  try {
    const userId = Number((req as any).userId);

    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [last7, last30] = await Promise.all([
      MoodLog.find({ userId, createdAt: { $gte: d7 } })
        .select("score createdAt")
        .sort({ createdAt: -1 })
        .lean(),
      MoodLog.find({ userId, createdAt: { $gte: d30 } })
        .select("score createdAt")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const avg = (arr: { score: number }[]) => {
      if (arr.length === 0) return null;
      const total = arr.reduce((s, l) => s + l.score, 0);
      return Math.round((total / arr.length) * 100) / 100;
    };

    res.json({
      ok: true,
      stats: {
        last7Days: { count: last7.length, avgScore: avg(last7) },
        last30Days: { count: last30.length, avgScore: avg(last30) },
      },
    });
  } catch (e: any) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: e.message || "Failed to get mood stats" });
  }
});

export default router;