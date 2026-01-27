import { Router } from "express";
import { UserSettings } from "../models/UserSettings"; // adjust path if needed

const router = Router();

// helper: validate "HH:MM" 24-hour
const isHHMM = (v: any) => {
  const s = String(v || "");
  if (!/^\d{2}:\d{2}$/.test(s)) return false;
  const [hh, mm] = s.split(":").map(Number);
  return (
    Number.isFinite(hh) &&
    Number.isFinite(mm) &&
    hh >= 0 &&
    hh <= 23 &&
    mm >= 0 &&
    mm <= 59
  );
};

// helper: normalize timezone aliases
const normalizeTimezone = (raw: string) => {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();

  if (low === "wib" || s === "+7" || s === "7" || low === "utc+7" || low === "gmt+7") {
    return "Asia/Jakarta";
  }

  return s;
};

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
      displayName: s.displayName || "",
      quietHours: s.quietHours,
    },
  });
});

// PUT /api/miniapp/settings
router.put("/", async (req: any, res) => {
  const userId = req.userId as number;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  // Build $set payload safely (partial updates)
  const $set: any = {};

  // -----------------------
  // DISPLAY NAME (new)
  // -----------------------
  if (req.body?.displayName !== undefined) {
    const dn = String(req.body.displayName ?? "").trim();

    if (dn.length > 48) {
      return res.status(400).json({
        error: "Display name is too long (max 48 characters).",
      });
    }

    // allow empty string to mean "no display name"
    $set.displayName = dn;
  }

  // -----------------------
  // TIMEZONE (existing, now optional)
  // -----------------------
  if (req.body?.timezone !== undefined) {
    const rawTz = String(req.body.timezone ?? "").trim();
    const normalizedTz = normalizeTimezone(rawTz);

    if (!normalizedTz) {
      return res.status(400).json({
        error: 'Invalid timezone. Use an IANA zone like "Asia/Jakarta".',
      });
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: normalizedTz }).format(new Date());
    } catch {
      return res.status(400).json({
        error: 'Invalid timezone. Use an IANA zone like "Asia/Jakarta".',
      });
    }

    $set.timezone = normalizedTz;
  }

  // -----------------------
  // QUIET HOURS (existing)
  // -----------------------
  if (req.body?.quietHours !== undefined) {
    const qh = req.body.quietHours;

    const enabled = !!qh?.enabled;
    const start = String(qh?.start ?? "23:00");
    const end = String(qh?.end ?? "08:00");

    if (!isHHMM(start) || !isHHMM(end)) {
      return res.status(400).json({
        error:
          'Invalid quietHours time. Use "HH:MM" 24-hour format (e.g. "23:00").',
      });
    }

    $set.quietHours = { enabled, start, end };
  }

  // If nothing to update, just return current settings (nice behavior)
  if (Object.keys($set).length === 0) {
    const existing =
      (await UserSettings.findOne({ userId }).lean()) ||
      (await UserSettings.create({ userId }));

    return res.json({
      ok: true,
      settings: {
        timezone: existing.timezone,
        displayName: existing.displayName || "",
        quietHours: existing.quietHours,
      },
    });
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
      displayName: updated?.displayName || "",
      quietHours: updated?.quietHours,
    },
  });
});

export default router;