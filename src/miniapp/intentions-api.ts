import { Router } from 'express';
import Intention from '../models/Intention';

const router = Router();

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
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );

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

    // Get start of today in UTC
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );

    // Delete any existing intention for today
    await Intention.deleteMany({
      userId: String(userId),
      setAt: { $gte: startOfDay },
    });

    // Create new intention
    const newIntention = new Intention({
      userId: String(userId),
      text,
      setAt: new Date(),
      updatedAt: new Date(),
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

    // Get start of today in UTC
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      )
    );

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
