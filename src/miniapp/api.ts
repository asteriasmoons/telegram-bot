// src/miniapp/api.ts
// Backend API for the Telegram Mini App

import { Router } from "express";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";
import crypto from "crypto";
import { DateTime } from "luxon";
import { computeNextRunAtWithTimes } from "../scheduler";

// ✅ ADDED (for Premium unlimited)
import { Premium } from "../models/Premium";

const router = Router();

/**
 * =========================================================
 * REMINDER CAPS CONFIG (ONLY ADDED -- NO LOGIC CHANGES)
 * =========================================================
 */

// CHANGE THIS to whatever free cap you want
const FREE_REMINDER_LIMIT = 3;

/**
 * CAP BYPASS (OWNER / ADMIN)
 * Add your Telegram user ID(s) here to bypass caps entirely.
 */
const CAP_BYPASS_USER_IDS = new Set<number>([
  6382917923, // <-- replace/confirm this is YOUR Telegram user id
]);

/**
 * Helper: is user premium right now?
 * Premium = unlimited reminders
 */
async function isPremiumActive(userId: number) {
  const now = new Date();

  const doc = await Premium.findOne({
    userId,
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean();

  return !!doc;
}

/**
 * Helper: count reminders for cap enforcement
 * NOTE: This does NOT change your reminder logic -- it only counts.
 *
 * We count "not deleted" reminders as "owned reminders" for cap purposes.
 * That means: scheduled/sent/etc count, deleted does not.
 */
async function countNonDeletedReminders(userId: number) {
  return Reminder.countDocuments({
    userId,
    status: { $ne: "deleted" },
  });
}

function normalizeTimesOfDay(schedule: any): string[] {
  const raw: unknown[] =
    Array.isArray(schedule?.timesOfDay) && schedule.timesOfDay.length
      ? schedule.timesOfDay
      : typeof schedule?.timeOfDay === "string" && schedule.timeOfDay
        ? [schedule.timeOfDay]
        : [];

  const times: string[] = raw
    .map((t) => String(t ?? "").trim())
    .filter((t) => /^\d{2}:\d{2}$/.test(t));

  const uniq: string[] = Array.from(new Set(times));
  uniq.sort((a, b) => a.localeCompare(b));
  return uniq;
}

// Middleware to validate Telegram Mini App init data
function validateTelegramWebAppData(initData: string, botToken: string): number | null {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  urlParams.delete("hash");

  if (!hash) return null;

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) return null;

  const userParam = urlParams.get("user");
  if (!userParam) return null;

  const user = JSON.parse(userParam);
  return user.id;
}

// Middleware to authenticate requests
router.use((req, res, next) => {
  const initData = req.headers["x-telegram-init-data"] as string;
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    return res.status(500).json({ error: "Bot token not configured" });
  }

  const userId = validateTelegramWebAppData(initData, botToken);

  if (!userId) {
    return res.status(401).json({ error: "Invalid Telegram data" });
  }

  req.userId = userId;
  next();
});

// GET /api/miniapp/reminders - Get all reminders for user
router.get("/reminders", async (req, res) => {
  try {
    const { status = "scheduled", includeHistory = "false" } = req.query;

    const query: any = { userId: req.userId };

    if (includeHistory === "true") {
      query.status = { $in: ["scheduled", "sent"] };
    } else {
      // For active reminders, include:
      // 1. All "scheduled" reminders
      // 2. "sent" reminders with recurring schedules that are due today or in the future
            query.$or = [
        { status: "scheduled" },
        {
          status: "sent",
          schedule: { $exists: true, $ne: null },
          "schedule.kind": { $in: ["daily", "weekly", "monthly", "yearly", "interval"] },
        }
      ];
    } 

    const reminders = await Reminder.find(query)
      .sort({ nextRunAt: 1 })
      .lean();

    // For display purposes, treat recurring "sent" reminders as "scheduled" if they're due soon
    const processedReminders = reminders.map(r => {
      if (r.status === "sent" && r.schedule && r.schedule.kind !== "once") {
        const nextRun = new Date(r.nextRunAt);
        const now = new Date();

        // If nextRunAt is today or future, show it as scheduled
        if (nextRun >= now || nextRun.toDateString() === now.toDateString()) {
          return { ...r, displayStatus: "scheduled" };
        }
      }
      return { ...r, displayStatus: r.status };
    });

    res.json({ reminders: processedReminders });
  } catch (error) {
    console.error("Error fetching reminders:", error);
    res.status(500).json({ error: "Failed to fetch reminders" });
  }
});

// GET /api/miniapp/reminders/:id - Get single reminder
router.get("/reminders/:id", async (req, res) => {
  try {
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    res.json({ reminder });
  } catch (error) {
    console.error("Error fetching reminder:", error);
    res.status(500).json({ error: "Failed to fetch reminder" });
  }
});

// POST /api/miniapp/reminders - Create new reminder
router.post("/reminders", async (req, res) => {
  try {
const { text, nextRunAt, schedule, timezone } = req.body;

    // ✅ normalize recurring times
    if (schedule && ["daily", "weekly", "monthly", "yearly"].includes(schedule.kind)) {
      const times = normalizeTimesOfDay(schedule);
      if (!times.length) {
        return res.status(400).json({ error: "Missing schedule.timesOfDay for recurring reminders" });
      }
      schedule.timesOfDay = times;
      schedule.timeOfDay = schedule.timeOfDay || times[0]; // keep legacy compatibility
    }

if (!text || !nextRunAt) {
  return res.status(400).json({ error: "Missing required fields" });
}

    /**
     * =========================================================
     * CAPS ENFORCEMENT (ONLY ADDED -- NO EXISTING LOGIC CHANGED)
     * =========================================================
     *
     * Rules:
     * - If userId is in CAP_BYPASS_USER_IDS => ignore caps.
     * - Else if Premium is active => unlimited.
     * - Else (free user) => cap at FREE_REMINDER_LIMIT reminders.
     */
    const userId = req.userId!; // ✅ FIX: req.userId is guaranteed by middleware; this removes TS "possibly undefined"
    const bypassCaps = CAP_BYPASS_USER_IDS.has(userId);

    if (!bypassCaps) {
      const premiumActive = await isPremiumActive(userId);

      if (!premiumActive) {
        const currentCount = await countNonDeletedReminders(userId);

        if (currentCount >= FREE_REMINDER_LIMIT) {
          return res.status(403).json({
            error: "REMINDER_LIMIT_REACHED",
            message: `Free users can create up to ${FREE_REMINDER_LIMIT} reminders. Upgrade to Premium for unlimited reminders.`,
            limit: FREE_REMINDER_LIMIT,
            current: currentCount,
          });
        }
      }
    }

    const settings = await UserSettings.findOne({ userId: req.userId }).lean();

    if (!settings?.dmChatId) {
      return res.status(400).json({ error: "DM chat not configured" });
    }
    
    // Use timezone from request if provided, otherwise fall back to saved user settings
const tz = String(timezone || settings.timezone || "America/Chicago").trim();

// ✅ validate schedule.interval for daily on create too
if (schedule?.kind === "daily") {
  if (!schedule.timeOfDay || !String(schedule.timeOfDay).includes(":")) {
    return res.status(400).json({ error: "Missing schedule.timeOfDay for daily reminders" });
  }

  const ivRaw = schedule.interval;
  const iv = ivRaw === undefined ? 1 : Number(ivRaw);

  if (!Number.isFinite(iv) || iv < 1 || iv > 365) {
    return res.status(400).json({ error: "Missing/invalid schedule.interval for daily reminders" });
  }

  schedule.interval = Math.trunc(iv);
}

    const reminder = await Reminder.create({
      userId: req.userId,
      chatId: settings.dmChatId,
      text,
      status: "scheduled",
      nextRunAt: new Date(nextRunAt),
      schedule: schedule || { kind: "once" },
      timezone: tz,
      lock: {}
    });

    res.json({ reminder });
  } catch (error) {
    console.error("Error creating reminder:", error);
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

// PUT /api/miniapp/reminders/:id - Update reminder
router.put("/reminders/:id", async (req, res) => {
  try {
    const { text, nextRunAt, schedule, status } = req.body;

    const update: any = {};
    if (text !== undefined) update.text = text;
if (nextRunAt !== undefined) {
  const dt = new Date(nextRunAt);
  if (isNaN(dt.getTime())) {
    return res.status(400).json({ error: "Invalid nextRunAt date" });
  }
  update.nextRunAt = dt;
}
if (schedule !== undefined) {
  const kind = schedule?.kind || "once";
  
    // ✅ normalize recurring times
  if (["daily", "weekly", "monthly", "yearly"].includes(kind)) {
    const times = normalizeTimesOfDay(schedule);
    if (!times.length) {
      return res.status(400).json({ error: "Missing schedule.timesOfDay for recurring reminders" });
    }
    schedule.timesOfDay = times;
    schedule.timeOfDay = schedule.timeOfDay || times[0];
  }

  // Validate timeOfDay for recurring kinds that use it
// Validate timeOfDay for recurring kinds that use it
if (kind === "daily" || kind === "weekly" || kind === "monthly") {
  if (!schedule.timeOfDay || !String(schedule.timeOfDay).includes(":")) {
    return res
      .status(400)
      .json({ error: "Missing schedule.timeOfDay for recurring reminders" });
  }
}

// ✅ daily interval support (every N days)
if (kind === "daily") {
  const ivRaw = schedule.interval;
  const iv = ivRaw === undefined ? 1 : Number(ivRaw);

  if (!Number.isFinite(iv) || iv < 1 || iv > 365) {
    return res.status(400).json({
      error: "Missing/invalid schedule.interval for daily reminders",
    });
  }

  schedule.interval = Math.trunc(iv);
}

  if (kind === "weekly") {
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing schedule.daysOfWeek for weekly reminders" });
    }
  }

  if (kind === "monthly") {
    const dom = Number(schedule.dayOfMonth);
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
      return res
        .status(400)
        .json({ error: "Missing/invalid schedule.dayOfMonth for monthly reminders" });
    }
  }

  if (kind === "interval") {
    const mins = Number(schedule.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return res
        .status(400)
        .json({ error: "Missing/invalid schedule.intervalMinutes for interval reminders" });
    }
  }
  
    if (kind === "yearly") {
    const m = Number(schedule.anchorMonth);
    const d = Number(schedule.anchorDay);
    if (!Number.isFinite(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: "Missing/invalid schedule.anchorMonth for yearly reminders" });
    }
    if (!Number.isFinite(d) || d < 1 || d > 31) {
      return res.status(400).json({ error: "Missing/invalid schedule.anchorDay for yearly reminders" });
    }
  }

  // ✅ IMPORTANT: actually persist schedule for ALL kinds
  update.schedule = schedule;
}
    if (status !== undefined) update.status = status;

    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: update },
      { new: true }
    ).lean();

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    res.json({ reminder });
  } catch (error) {
    console.error("Error updating reminder:", error);
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

// POST /api/miniapp/reminders/:id/snooze - Snooze reminder
router.post("/reminders/:id/snooze", async (req, res) => {
  try {
    const { minutes = 15 } = req.body;

    const newTime = new Date(Date.now() + minutes * 60 * 1000);

    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { nextRunAt: newTime, status: "scheduled" } },
      { new: true }
    ).lean();

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    res.json({ reminder });
  } catch (error) {
    console.error("Error snoozing reminder:", error);
    res.status(500).json({ error: "Failed to snooze reminder" });
  }
});

function computeNextRunFromSchedule(
  schedule: any,
  tz: string,
  fromDate: Date
): Date | null {
  if (!schedule || schedule.kind === "once") return null;

  const from = DateTime.fromJSDate(fromDate, { zone: tz });

  if (schedule.kind === "interval") {
    const mins = Number(schedule.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return from.plus({ minutes: mins }).toJSDate();
  }

const timeOfDay = String(schedule.timeOfDay || "");
const [hRaw, mRaw] = timeOfDay.split(":");

const hour = Number(hRaw);
const minute = Number(mRaw);

if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

if (schedule.kind === "daily") {
const raw = Number(schedule.interval);
const step = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;

  let candidate = from.set({ hour, minute, second: 0, millisecond: 0 });

  // advance by N days until it's in the future
  while (candidate <= from) {
    candidate = candidate.plus({ days: step });
  }

  return candidate.toJSDate();
}

  if (schedule.kind === "weekly") {
    const days: number[] = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    if (days.length === 0) return null;

    // Your format: 0=Sun..6=Sat
    // Luxon: 1=Mon..7=Sun
    const luxonDays = days
      .map(Number)
      .filter(Number.isFinite)
      .map((d) => (d === 0 ? 7 : d)); // Sun(0)->7, Mon(1)->1, ... Sat(6)->6

    for (let add = 0; add <= 7; add++) {
      const d = from.plus({ days: add });
      if (!luxonDays.includes(d.weekday)) continue;

      const candidate = d.set({ hour, minute, second: 0, millisecond: 0 });
      if (candidate > from) return candidate.toJSDate();
    }

    // fallback: 1 week later same time
    return from.plus({ days: 7 }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
  }
  
    if (schedule.kind === "monthly") {
    const domRaw = Number(schedule.dayOfMonth);
    if (!Number.isFinite(domRaw) || domRaw < 1 || domRaw > 31) return null;

    // Luxon will clamp invalid dates in some cases; we want predictable behavior:
    // If the month doesn't have that day (e.g., 31 in Feb), run on the LAST day of that month.
    const desiredDom = Math.trunc(domRaw);

    // Helper: get last day of month for a DateTime
    const lastDayOfMonth = (dt: any) => dt.endOf("month").day;

    // Try this month, then next month
    for (let addMonths = 0; addMonths <= 12; addMonths++) {
      const base = from.plus({ months: addMonths }).startOf("month");
      const last = lastDayOfMonth(base);
      const day = Math.min(desiredDom, last);

      const candidate = base.set({ day, hour, minute, second: 0, millisecond: 0 });

      if (candidate > from) return candidate.toJSDate();
    }

    return null;
  }
  
    return null;
}


// POST /api/miniapp/reminders/:id/done - Mark as done (and reschedule recurring)
router.post("/reminders/:id/done", async (req, res) => {
  try {
    const now = new Date();

    const rem = await Reminder.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!rem) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    
    const kind = rem.schedule?.kind || "once"; 

const settings = await UserSettings.findOne({ userId: req.userId }).lean();
const tz = settings?.timezone || rem.timezone || "America/Chicago";

    // One-time reminders: mark sent and stop
    if (kind === "once") {
      const updated = await Reminder.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        { $set: { status: "sent", lastRunAt: now } },
        { new: true }
      ).lean();

      return res.json({ reminder: updated });
    }

        // Recurring reminders: advance nextRunAt and keep scheduled
    // Use whichever is later (now vs nextRunAt) so we always skip
    // past the current occurrence -- even if marked done early.
    const currentRunAt = rem.nextRunAt ? new Date(rem.nextRunAt) : now;
    const fromDate = new Date(Math.max(now.getTime(), currentRunAt.getTime()));
    const next = rem.pendingNextRunAt
      ? new Date(rem.pendingNextRunAt)
      : computeNextRunAtWithTimes(rem, fromDate);

    if (!next) {
      return res.status(500).json({ error: "Could not compute next run time" });
    }

    const updated = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      {
        $set: { status: "scheduled", lastRunAt: now, nextRunAt: next },
        $unset: { pendingNextRunAt: 1 },
      },
      { new: true }
    ).lean();

    res.json({ reminder: updated });
  } catch (error) {
    console.error("Error marking reminder as done:", error);
    res.status(500).json({ error: "Failed to mark as done" });
  }
});

// DELETE /api/miniapp/reminders/:id - Delete reminder
router.delete("/reminders/:id", async (req, res) => {
  try {
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { status: "deleted" } },
      { new: true }
    ).lean();

    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    res.json({ reminder });
  } catch (error) {
    console.error("Error deleting reminder:", error);
    res.status(500).json({ error: "Failed to delete reminder" });
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