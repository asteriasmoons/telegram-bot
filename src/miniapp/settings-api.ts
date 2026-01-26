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

  // -----------------------
  // TIMEZONE (existing)
  // -----------------------
  const rawTz = String(req.body?.timezone || "").trim();

  const normalizedTz =
    rawTz.toLowerCase() === "wib" ||
    rawTz === "+7" ||
    rawTz === "7" ||
    rawTz === "utc+7" ||
    rawTz === "gmt+7"
      ? "Asia/Jakarta"
      : rawTz;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedTz }).format(new Date());
  } catch {
    return res.status(400).json({
      error: 'Invalid timezone. Use an IANA zone like "Asia/Jakarta".',
    });
  }

  // -----------------------
  // QUIET HOURS (new)
  // -----------------------
  const qh = req.body?.quietHours;

  // helper: validate "HH:MM" 24-hour
  const isHHMM = (v: any) => {
    const s = String(v || "");
    if (!/^\d{2}:\d{2}$/.test(s)) return false;
    const [hh, mm] = s.split(":").map(Number);
    return Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  };

  // Build $set payload safely
  const $set: any = { timezone: normalizedTz };

  if (qh !== undefined) {
    const enabled = !!qh?.enabled;
    const start = String(qh?.start ?? "23:00");
    const end = String(qh?.end ?? "08:00");

    if (!isHHMM(start) || !isHHMM(end)) {
      return res.status(400).json({
        error: 'Invalid quietHours time. Use "HH:MM" 24-hour format (e.g. "23:00").',
      });
    }

    $set.quietHours = { enabled, start, end };
  }

  const updated = await UserSettings.findOneAndUpdate(
    { userId },
    { $set },
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