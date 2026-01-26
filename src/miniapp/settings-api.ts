import { Router } from "express";
import { UserSettings } from "../models/UserSettings"; // adjust path if needed

const router = Router();

// GET /api/miniapp/settings
router.get("/", async (req: any, res) => {
  const userId = req.userId as number;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const s =
    (await UserSettings.findOne({ userId }).lean()) ||
    (await UserSettings.create({ userId }));

  return res.json({
    settings: {
      timezone: s.timezone,
      quietHours: s.quietHours,
    },
  });
});

// PUT /api/miniapp/settings
router.put("/", async (req: any, res) => {
  const userId = req.userId as number;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const raw = String(req.body?.timezone || "").trim();

  // Optional niceness: accept "+7" or "WIB" and map it
  const normalized =
    raw.toLowerCase() === "wib" || raw === "+7" || raw === "7" || raw === "utc+7" || raw === "gmt+7"
      ? "Asia/Jakarta"
      : raw;

  // Validate IANA timezone using Intl
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    return res.status(400).json({
      error: 'Invalid timezone. Use an IANA zone like "Asia/Jakarta".',
    });
  }

  const updated = await UserSettings.findOneAndUpdate(
    { userId },
    { $set: { timezone: normalized } },
    { upsert: true, new: true }
  ).lean();

  return res.json({
    ok: true,
    settings: {
      timezone: updated?.timezone,
      quietHours: updated?.quietHours,
    },
  });
});

export default router;