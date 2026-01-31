import { Router } from "express";
import mongoose from "mongoose";
import { Habit } from "../models/Habit";
import { HabitLog } from "../models/HabitLog";

const router = Router();

/**
 * IMPORTANT:
 * Replace this with however you currently authenticate/identify the Telegram user.
 * Common patterns:
 * - req.user.id (if you already attach it in middleware)
 * - req.tgUserId (custom)
 * - header "x-user-id" or "x-telegram-user-id"
 *
 * I'm keeping it explicit and strict so you don't accidentally write habits to the wrong user.
 */
function requireUserId(req: any): number {
  const userId = Number(req.userId);
  if (!Number.isFinite(userId) || userId <= 0) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  return userId;
}

function okTimeHHmm(s: any) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return false;
  const [hh, mm] = t.split(":").map(Number);
  return Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function clampDaysOfWeek(days: any): number[] {
  if (!Array.isArray(days)) return [];
  return days
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6);
}

function bad(res: any, message: string, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

/**
 * GET /api/habits
 * List habits (optionally include paused with ?includePaused=1)
 */
router.get("/habits", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const includePaused = String(req.query.includePaused || "") === "1";

    const q: any = { userId };
    if (!includePaused) q.status = "active";

    const habits = await Habit.find(q).sort({ updatedAt: -1 }).lean();
    res.json({ ok: true, habits });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to list habits" });
  }
});

/**
 * POST /api/habits
 * Create a habit
 */
router.post("/habits", async (req, res) => {
  try {
    const userId = requireUserId(req);

    const {
      chatId,
      name,
      description,
      status,
      cadence,
      targetCount,
      targetAmount,
      unit,
      timezone,
      reminderSchedule,
      nextReminderAt,
    } = req.body || {};

    if (!Number.isFinite(Number(chatId))) return bad(res, "chatId is required");
    if (typeof name !== "string" || !name.trim()) return bad(res, "name is required");
    if (typeof timezone !== "string" || !timezone.trim()) return bad(res, "timezone is required");

    const tc = Number(targetCount);
    if (!Number.isFinite(tc) || tc < 1) return bad(res, "targetCount must be >= 1");

    const sched = reminderSchedule || { kind: "off" };
    if (!sched.kind) sched.kind = "off";

    // Validate schedule by kind
    if (sched.kind === "times") {
      const times = Array.isArray(sched.timesOfDay) ? sched.timesOfDay : [];
      if (times.length === 0) return bad(res, "timesOfDay is required for kind=times");
      if (!times.every(okTimeHHmm)) return bad(res, "timesOfDay must be HH:mm values");
      sched.timesOfDay = times.map((t: string) => t.trim());
    } else if (sched.kind === "hourly") {
      const everyHours = Number(sched.everyHours);
      if (!Number.isFinite(everyHours) || everyHours < 1) return bad(res, "everyHours must be >= 1");
      sched.everyHours = everyHours;
      if (sched.windowStart && !okTimeHHmm(sched.windowStart)) return bad(res, "windowStart must be HH:mm");
      if (sched.windowEnd && !okTimeHHmm(sched.windowEnd)) return bad(res, "windowEnd must be HH:mm");
    } else if (sched.kind === "every_x_minutes") {
      const everyMinutes = Number(sched.everyMinutes);
      if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return bad(res, "everyMinutes must be >= 1");
      sched.everyMinutes = everyMinutes;
      if (sched.windowStart && !okTimeHHmm(sched.windowStart)) return bad(res, "windowStart must be HH:mm");
      if (sched.windowEnd && !okTimeHHmm(sched.windowEnd)) return bad(res, "windowEnd must be HH:mm");
    } else if (sched.kind === "off") {
      // fine
    } else {
      return bad(res, "Invalid reminderSchedule.kind");
    }

    if (sched.daysOfWeek) {
      sched.daysOfWeek = clampDaysOfWeek(sched.daysOfWeek);
    }

    const doc = await Habit.create({
      userId,
      chatId: Number(chatId),

      name: name.trim(),
      description: typeof description === "string" ? description.trim() : undefined,

      status: status === "paused" ? "paused" : "active",

      cadence: cadence === "weekly" ? "weekly" : "daily",
      targetCount: tc,
      targetAmount: Number.isFinite(Number(targetAmount)) ? Number(targetAmount) : undefined,
      unit: unit || "sessions",

      timezone: timezone.trim(),

      reminderSchedule: sched,
      nextReminderAt: nextReminderAt ? new Date(nextReminderAt) : undefined,
    });

    res.json({ ok: true, habit: doc.toObject() });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to create habit" });
  }
});

/**
 * GET /api/habits/:id
 * Fetch a single habit
 */
router.get("/habits/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);

    if (!isObjectId(id)) return bad(res, "Invalid habit id");

    const habit = await Habit.findOne({ _id: id, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    res.json({ ok: true, habit });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to fetch habit" });
  }
});

/**
 * PUT /api/habits/:id
 * Edit habit (including reminderSchedule + nextReminderAt)
 */
router.put("/habits/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);

    if (!isObjectId(id)) return bad(res, "Invalid habit id");

    const patch: any = {};
    const b = req.body || {};

    if (typeof b.name === "string") patch.name = b.name.trim();
    if (typeof b.description === "string") patch.description = b.description.trim();
    if (b.description === null) patch.description = undefined;

    if (b.status === "active" || b.status === "paused") patch.status = b.status;

    if (b.cadence === "daily" || b.cadence === "weekly") patch.cadence = b.cadence;

    if (b.targetCount !== undefined) {
      const tc = Number(b.targetCount);
      if (!Number.isFinite(tc) || tc < 1) return bad(res, "targetCount must be >= 1");
      patch.targetCount = tc;
    }

    if (b.targetAmount !== undefined) {
      if (b.targetAmount === null || b.targetAmount === "") {
        patch.targetAmount = undefined;
      } else {
        const ta = Number(b.targetAmount);
        if (!Number.isFinite(ta) || ta < 0) return bad(res, "targetAmount must be >= 0");
        patch.targetAmount = ta;
      }
    }

    if (b.unit !== undefined) patch.unit = b.unit;

    if (typeof b.timezone === "string" && b.timezone.trim()) patch.timezone = b.timezone.trim();

    if (b.reminderSchedule) {
      const sched = { ...b.reminderSchedule };

      if (!sched.kind) return bad(res, "reminderSchedule.kind is required");

      if (sched.kind === "times") {
        const times = Array.isArray(sched.timesOfDay) ? sched.timesOfDay : [];
        if (times.length === 0) return bad(res, "timesOfDay is required for kind=times");
        if (!times.every(okTimeHHmm)) return bad(res, "timesOfDay must be HH:mm values");
        sched.timesOfDay = times.map((t: string) => t.trim());
      } else if (sched.kind === "hourly") {
        const everyHours = Number(sched.everyHours);
        if (!Number.isFinite(everyHours) || everyHours < 1) return bad(res, "everyHours must be >= 1");
        sched.everyHours = everyHours;
        if (sched.windowStart && !okTimeHHmm(sched.windowStart)) return bad(res, "windowStart must be HH:mm");
        if (sched.windowEnd && !okTimeHHmm(sched.windowEnd)) return bad(res, "windowEnd must be HH:mm");
      } else if (sched.kind === "every_x_minutes") {
        const everyMinutes = Number(sched.everyMinutes);
        if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return bad(res, "everyMinutes must be >= 1");
        sched.everyMinutes = everyMinutes;
        if (sched.windowStart && !okTimeHHmm(sched.windowStart)) return bad(res, "windowStart must be HH:mm");
        if (sched.windowEnd && !okTimeHHmm(sched.windowEnd)) return bad(res, "windowEnd must be HH:mm");
      } else if (sched.kind === "off") {
        // fine
      } else {
        return bad(res, "Invalid reminderSchedule.kind");
      }

      if (sched.daysOfWeek) {
        sched.daysOfWeek = clampDaysOfWeek(sched.daysOfWeek);
      }

      patch.reminderSchedule = sched;
    }

    if (b.nextReminderAt !== undefined) {
      patch.nextReminderAt = b.nextReminderAt ? new Date(b.nextReminderAt) : undefined;
    }

    const updated = await Habit.findOneAndUpdate(
      { _id: id, userId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!updated) return bad(res, "Habit not found", 404);

    res.json({ ok: true, habit: updated });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to update habit" });
  }
});

/**
 * DELETE /api/habits/:id
 * HARD delete: habit + ALL logs (your requirement)
 */
router.delete("/habits/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);

    if (!isObjectId(id)) return bad(res, "Invalid habit id");

    const habit = await Habit.findOne({ _id: id, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    await Habit.deleteOne({ _id: id, userId });
    await HabitLog.deleteMany({ habitId: id, userId });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to delete habit" });
  }
});

/**
 * GET /api/habits/:id/logs
 * Query logs. Supports:
 * - ?from=ISO&to=ISO
 * - ?limit=50&skip=0
 */
router.get("/habits/:id/logs", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);

    if (!isObjectId(id)) return bad(res, "Invalid habit id");

    const habit = await Habit.findOne({ _id: id, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    const q: any = { userId, habitId: id };

    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;

    if (from && !isNaN(from.getTime())) q.startedAt = { ...(q.startedAt || {}), $gte: from };
    if (to && !isNaN(to.getTime())) q.startedAt = { ...(q.startedAt || {}), $lte: to };

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = Math.max(0, Number(req.query.skip || 0));

    const logs = await HabitLog.find(q)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ ok: true, logs });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to list habit logs" });
  }
});

/**
 * POST /api/habits/:id/logs
 * Create a session log
 * Required: startedAt
 * Optional: endedAt, amount
 * unit comes from habit by default unless explicitly set (I keep it strict: prefer habit’s unit)
 */
router.post("/habits/:id/logs", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const id = String(req.params.id);
    if (!isObjectId(id)) return bad(res, "Invalid habit id");

    const habit = await Habit.findOne({ _id: id, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    const { startedAt, endedAt, amount } = req.body || {};
    if (!startedAt) return bad(res, "startedAt is required");

    const s = new Date(startedAt);
    if (isNaN(s.getTime())) return bad(res, "startedAt must be a valid date");

    let e: Date | undefined = undefined;
    if (endedAt) {
      const d = new Date(endedAt);
      if (isNaN(d.getTime())) return bad(res, "endedAt must be a valid date");
      e = d;
      if (e.getTime() < s.getTime()) return bad(res, "endedAt cannot be before startedAt");
    }

    let amt: number | undefined = undefined;
    if (amount !== undefined && amount !== null && amount !== "") {
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) return bad(res, "amount must be >= 0");
      amt = n;
    }

    const log = await HabitLog.create({
      userId,
      habitId: habit._id,
      startedAt: s,
      endedAt: e,
      amount: amt,
      unit: habit.unit, // keep consistent with the habit definition
    });

    res.json({ ok: true, log: log.toObject() });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to create habit log" });
  }
});

/**
 * PUT /api/habits/:id/logs/:logId
 * Edit a log session (start/end/amount)
 */
router.put("/habits/:id/logs/:logId", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const habitId = String(req.params.id);
    const logId = String(req.params.logId);

    if (!isObjectId(habitId)) return bad(res, "Invalid habit id");
    if (!isObjectId(logId)) return bad(res, "Invalid log id");

    const habit = await Habit.findOne({ _id: habitId, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    const patch: any = {};

    if (req.body?.startedAt !== undefined) {
      const s = req.body.startedAt ? new Date(req.body.startedAt) : null;
      if (!s || isNaN(s.getTime())) return bad(res, "startedAt must be a valid date");
      patch.startedAt = s;
    }

    if (req.body?.endedAt !== undefined) {
      if (!req.body.endedAt) {
        patch.endedAt = undefined;
      } else {
        const e = new Date(req.body.endedAt);
        if (isNaN(e.getTime())) return bad(res, "endedAt must be a valid date");
        patch.endedAt = e;
      }
    }

    if (req.body?.amount !== undefined) {
      if (req.body.amount === null || req.body.amount === "") {
        patch.amount = undefined;
      } else {
        const n = Number(req.body.amount);
        if (!Number.isFinite(n) || n < 0) return bad(res, "amount must be >= 0");
        patch.amount = n;
      }
    }

    // Keep unit locked to habit’s unit
    patch.unit = habit.unit;

    // If both start and end are being set, validate ordering
    if (patch.startedAt && patch.endedAt && patch.endedAt.getTime() < patch.startedAt.getTime()) {
      return bad(res, "endedAt cannot be before startedAt");
    }

    const updated = await HabitLog.findOneAndUpdate(
      { _id: logId, userId, habitId: habit._id },
      { $set: patch },
      { new: true }
    ).lean();

    if (!updated) return bad(res, "Log not found", 404);

    res.json({ ok: true, log: updated });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to update habit log" });
  }
});

/**
 * DELETE /api/habits/:id/logs/:logId
 * Delete a single log session
 */
router.delete("/habits/:id/logs/:logId", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const habitId = String(req.params.id);
    const logId = String(req.params.logId);

    if (!isObjectId(habitId)) return bad(res, "Invalid habit id");
    if (!isObjectId(logId)) return bad(res, "Invalid log id");

    const habit = await Habit.findOne({ _id: habitId, userId }).lean();
    if (!habit) return bad(res, "Habit not found", 404);

    const r = await HabitLog.deleteOne({ _id: logId, userId, habitId: habit._id });
    if (r.deletedCount === 0) return bad(res, "Log not found", 404);

    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Failed to delete habit log" });
  }
});

export default router;