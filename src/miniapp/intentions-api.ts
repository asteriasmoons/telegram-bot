import { Router } from 'express';
import { DateTime } from "luxon";
import { UserSettings } from "../models/UserSettings";
import Intention from '../models/Intention';

const router = Router();

// HELPERS HELPERS HELPERS 
async function getUserTz(userId: number) {
  const s = await UserSettings.findOne({ userId }).lean();
  return String(s?.timezone || "America/Chicago");
}

function startOfTodayInTz(tz: string) {
  // Start of the user's local day, expressed as a real JS Date (UTC instant)
  return DateTime.now().setZone(tz).startOf("day").toUTC().toJSDate();
}

/**
 * GET /api/miniapp/intention
 * Get today's intention
 */
router.get('/intention', async (req, res) => {
  try {
    const userId = Number((req as any).userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Unauthorized - invalid userId" });
    }

    // Get start of today in UTC
     const tz = await getUserTz(userId);
     const startOfDay = startOfTodayInTz(tz);

    // Find intention set today
    const intention = await Intention.findOne({
      userId: String(userId),
      setAt: { $gte: startOfDay },
    })
      .sort({ setAt: -1 })
      .lean();

    res.json({
      ok: true,
      intention: intention?.text || null,
      setAt: intention?.setAt || null,
    });
  } catch (error) {
    console.error('Get intention error:', error);
    res.status(500).json({ ok: false, error: 'Failed to get intention' });
  }
});

/**
 * POST /api/miniapp/intention
 * Set today's intention (replaces existing if present)
 */
router.post('/intention', async (req, res) => {
  try {
    const userId = Number((req as any).userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Unauthorized - invalid userId" });
    }

    const { intention } = req.body;

    // Validate input
    if (!intention || typeof intention !== 'string' || !intention.trim()) {
      return res.status(400).json({ ok: false, error: 'Intention text required' });
    }

    const text = intention.trim();

    if (text.length > 2000) {
      return res
        .status(400)
        .json({ ok: false, error: 'Intention too long (max 2000 characters)' });
    }

    const tz = await getUserTz(userId);
    const startOfDay = startOfTodayInTz(tz);

    // Create new intention (keep history)
     const newIntention = new Intention({
     userId: String(userId),
     text,
     setAt: new Date(), // keep as the instant it was set
});

      await newIntention.save();

    res.json({
      ok: true,
      intention: newIntention.text,
      setAt: newIntention.setAt,
    });
  } catch (error) {
    console.error('Set intention error:', error);
    res.status(500).json({ ok: false, error: 'Failed to set intention' });
  }
});

/**
 * DELETE /api/miniapp/intention
 * Clear today's intention
 */
router.delete('/intention', async (req, res) => {
  try {
    const userId = Number((req as any).userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Unauthorized - invalid userId" });
    }

    const tz = await getUserTz(userId);
    const startOfDay = startOfTodayInTz(tz);

    // Delete today's intention
    await Intention.deleteMany({
      userId: String(userId),
      setAt: { $gte: startOfDay },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Clear intention error:', error);
    res.status(500).json({ ok: false, error: 'Failed to clear intention' });
  }
});

export default router;
