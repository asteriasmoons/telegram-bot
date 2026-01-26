// src/miniapp/calendar-api.ts
// Calendar API endpoints (with optional linked reminder support)

import { Router } from "express";
import { Event } from "../models/Event";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";
import { Premium } from "../models/Premium"; // ✅ needed for Premium bypass

const router = Router();

/**
 * ===============================
 * CAP SETTINGS + BYPASS
 * ===============================
 */
const EVENT_REMINDER_CAP = 3;

// ✅ OWNER / DEV BYPASS (hardcoded, no env vars)
const CAP_BYPASS_USER_IDS = new Set<number>([
  6382917923, // <-- replace/confirm this is YOUR Telegram user id
]);

function hasCapBypass(userId: number) {
  return CAP_BYPASS_USER_IDS.has(Number(userId));
}

async function isPremiumActive(userId: number) {
  const doc = await Premium.findOne({ userId }).lean();
  if (!doc || !doc.isActive) return false;
  if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

async function countReminderEvents(userId: number) {
  // Count how many events currently have a linked reminder
  return Event.countDocuments({
    userId,
    reminderId: { $ne: null }
  });
}

/**
 * Builds the default reminder text from an event.
 * You asked: template should show the whole description.
 */
function buildEventReminderText(event: {
  title: string;
  description?: string;
  location?: string;
}) {
  const parts: string[] = [];
  parts.push(event.title);

  if (event.description && event.description.trim()) {
    parts.push(event.description.trim());
  }

  if (event.location && event.location.trim()) {
    parts.push(`📍 ${event.location.trim()}`);
  }

  // IMPORTANT: join with blank line to keep formatting readable in mini app
  // (your CSS uses white-space: pre-line on .card-text which preserves \n)
  return parts.join("\n\n");
}

type ReminderPayload =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      mode: "at_event" | "offset" | "custom";
      offsetMinutes?: number; // required when mode=offset
      customDateTime?: string; // required when mode=custom (ISO string)
    };

function isValidISODateString(s: unknown) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function computeReminderNextRunAt(args: {
  eventStart: Date;
  reminder: ReminderPayload;
}) {
  const { eventStart, reminder } = args;

  if (!reminder || reminder.enabled === false) return null;

  if (reminder.mode === "at_event") {
    return new Date(eventStart);
  }

  if (reminder.mode === "offset") {
    const mins = Number(reminder.offsetMinutes);
    if (!Number.isFinite(mins) || mins < 0) return null;
    return new Date(eventStart.getTime() - mins * 60_000);
  }

  if (reminder.mode === "custom") {
    if (!isValidISODateString(reminder.customDateTime)) return null;
    return new Date(reminder.customDateTime as string);
  }

  return null;
}

/**
 * Create/update/delete linked reminder for an event.
 * - Uses user's dmChatId (like your reminders endpoint does)
 * - Uses user's timezone if present (fallback America/Chicago)
 * - Returns updated event doc with reminderId set/cleared
 */
async function upsertEventReminder(args: {
  userId: number;
  eventId: string;
  existingReminderId?: any;
  eventDataForText: { title: string; description?: string; location?: string };
  nextRunAt: Date | null;
}) {
  const { userId, eventId, existingReminderId, eventDataForText, nextRunAt } = args;

  // If reminder is disabled: delete linked reminder (soft-delete) and return clear
  if (!nextRunAt) {
    if (existingReminderId) {
      await Reminder.findOneAndUpdate(
        { _id: existingReminderId, userId },
        { $set: { status: "deleted" } },
        { new: true }
      ).lean();
    }
    return { reminderId: null as any };
  }

  // Need DM chat id
  const settings = await UserSettings.findOne({ userId }).lean();
  if (!settings?.dmChatId) {
    // If user hasn't configured DM chat id, we cannot create reminders.
    // Fail loudly so the mini app can show a message.
    throw new Error("DM chat not configured");
  }

  const timezone = settings?.timezone || "America/Chicago";
  const text = buildEventReminderText(eventDataForText);

  // IMPORTANT: We are creating a ONE-TIME reminder for the event reminder feature.
  // You can expand later if you want repeating event reminders.
  const schedule = { kind: "once" as const };

  // If reminder exists, update it
  if (existingReminderId) {
    const updated = await Reminder.findOneAndUpdate(
      { _id: existingReminderId, userId },
      {
        $set: {
          text,
          nextRunAt,
          schedule,
          timezone,
          status: "scheduled"
        }
      },
      { new: true }
    ).lean();

    // If it somehow didn't exist, fall through to create
    if (updated) {
      return { reminderId: updated._id };
    }
  }

  // Otherwise create a new reminder and link it
  const created = await Reminder.create({
    userId,
    chatId: settings.dmChatId,
    text,
    status: "scheduled",
    nextRunAt,
    schedule,
    timezone,
    // your reminders use lock:{} so keep consistent
    lock: {},
    // optional meta if your schema allows (if it doesn't, mongoose ignores unknown fields)
    // meta: { kind: "event", eventId }
  });

  return { reminderId: created._id };
}

function startOfDayKey(d: Date) {
  // "YYYY-MM-DD" in local time of the Date object
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampDayOfMonth(year: number, month0: number, desiredDay: number) {
  // month0 is 0..11
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  return Math.min(desiredDay, lastDay);
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function addWeeks(d: Date, weeks: number) {
  return addDays(d, weeks * 7);
}

function addMonthsClamped(d: Date, months: number) {
  const year = d.getFullYear();
  const month0 = d.getMonth();
  const day = d.getDate();

  const targetMonthIndex = month0 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth0 = ((targetMonthIndex % 12) + 12) % 12;

  const safeDay = clampDayOfMonth(targetYear, targetMonth0, day);
  const out = new Date(d);
  out.setFullYear(targetYear);
  out.setMonth(targetMonth0);
  out.setDate(safeDay);
  return out;
}

function addYearsClamped(d: Date, years: number) {
  const year = d.getFullYear() + years;
  const month0 = d.getMonth();
  const day = d.getDate();
  const safeDay = clampDayOfMonth(year, month0, day);

  const out = new Date(d);
  out.setFullYear(year);
  out.setMonth(month0);
  out.setDate(safeDay);
  return out;
}

function isRecurrenceActiveOnDate(rule: any, occurrenceIndex: number, occurrenceDate: Date) {
  const end = rule?.end;
  if (!end || end.kind === "never") return true;

  if (end.kind === "count") {
    const c = Number(end.count);
    if (!Number.isFinite(c) || c < 1) return false;
    return occurrenceIndex < c;
  }

  if (end.kind === "until") {
    const until = new Date(end.until);
    if (isNaN(until.getTime())) return true;
    // occurrence must be <= until (date-time)
    return occurrenceDate.getTime() <= until.getTime();
  }

  return true;
}

function expandRecurringEventIntoRange(event: any, rangeStart: Date, rangeEnd: Date) {
  const rule = event.recurrence;
  if (!rule) return [];

  const freq = String(rule.freq || "").toLowerCase();
  const interval = Math.max(1, Number(rule.interval || 1));

  const exceptions = new Set<string>(Array.isArray(event.recurrenceExceptions) ? event.recurrenceExceptions : []);

  // Base template for occurrences
  const baseStart = new Date(event.startDate);
  const baseEnd = event.endDate ? new Date(event.endDate) : null;
  const durationMs = baseEnd ? baseEnd.getTime() - baseStart.getTime() : 0;

  const occurrences: any[] = [];

  // We’ll generate by stepping forward from baseStart until we pass rangeEnd.
  // For performance: if baseStart is far before rangeStart, we fast-forward roughly for daily/weekly/monthly/yearly.
  let current = new Date(baseStart);
  let index = 0;

  // Fast-forward (rough) to reduce iterations for daily/weekly
  if (current < rangeStart) {
    if (freq === "daily") {
      const diffDays = Math.floor((rangeStart.getTime() - current.getTime()) / 86400000);
      const jumps = Math.floor(diffDays / interval) * interval;
      if (jumps > 0) {
        current = addDays(current, jumps);
        index += Math.floor(jumps / interval);
      }
    } else if (freq === "weekly") {
      const diffDays = Math.floor((rangeStart.getTime() - current.getTime()) / 86400000);
      const diffWeeks = Math.floor(diffDays / 7);
      const jumps = Math.floor(diffWeeks / interval) * interval;
      if (jumps > 0) {
        current = addWeeks(current, jumps);
        index += Math.floor(jumps / interval);
      }
    } else if (freq === "monthly") {
      // monthly/yearly fast-forward safely by stepping months/years (still not too costly for calendar windows)
      while (current < rangeStart) {
        const next = addMonthsClamped(current, interval);
        if (next.getTime() === current.getTime()) break;
        current = next;
        index += 1;
        if (index > 5000) break;
      }
    } else if (freq === "yearly") {
      while (current < rangeStart) {
        const next = addYearsClamped(current, interval);
        if (next.getTime() === current.getTime()) break;
        current = next;
        index += 1;
        if (index > 5000) break;
      }
    }
  }

  const byWeekday =
    Array.isArray(rule.byWeekday) && rule.byWeekday.length
      ? new Set(rule.byWeekday.map((n: any) => Number(n)).filter((n: number) => n >= 0 && n <= 6))
      : null;

  // Generate
  while (current <= rangeEnd) {
    // Stop if recurrence ended
    if (!isRecurrenceActiveOnDate(rule, index, current)) break;

    // Weekly weekday filter: only include certain weekdays
    if (freq === "weekly" && byWeekday) {
      const dow = current.getDay(); // 0..6
      if (!byWeekday.has(dow)) {
        // move one day forward within the week until we hit a valid weekday,
        // but still advance overall in a controlled manner:
        // simplest: walk day-by-day, but guard it.
        const nextDay = addDays(current, 1);
        current = nextDay;
        continue;
      }
    }

    const occStart = new Date(current);
    const occEnd = baseEnd ? new Date(occStart.getTime() + durationMs) : null;

    // Exceptions are stored by day key (keeps it simple for all-day + timed)
    const key = startOfDayKey(occStart);
    if (!exceptions.has(key)) {
      // Only include occurrences that overlap the range
      // For timed events, check start within range; for multi-day, check overlap
      const overlaps =
        occEnd
          ? occStart <= rangeEnd && occEnd >= rangeStart
          : occStart >= rangeStart && occStart <= rangeEnd;

      if (overlaps) {
        occurrences.push({
          ...event,
          parentId: event._id,
          occurrenceId: `${String(event._id)}|${occStart.toISOString()}`,
          isOccurrence: true,
          startDate: occStart,
          endDate: occEnd || undefined
        });
      }
    }

    // Advance to next
    if (freq === "daily") current = addDays(current, interval);
    else if (freq === "weekly") current = addWeeks(current, interval);
    else if (freq === "monthly") current = addMonthsClamped(current, interval);
    else if (freq === "yearly") current = addYearsClamped(current, interval);
    else break;

    index += 1;

    // safety guard
    if (index > 5000) break;
  }

  return occurrences;
}

// GET /api/miniapp/calendar/events - Get events for a date range
router.get("/events", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const rangeStart = new Date(startDate as string);
    const rangeEnd = new Date(endDate as string);

    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    // 1) non-recurring events in range (your original behavior)
    const oneTime = await Event.find({
      userId: req.userId,
      recurrence: { $exists: false },
      startDate: { $gte: rangeStart, $lte: rangeEnd }
    })
      .sort({ startDate: 1 })
      .lean();

    // 2) recurring parent events that could affect the range
    // We include parents whose startDate is <= rangeEnd
    // (and optionally: whose "until" is >= rangeStart, but we keep it simple here)
    const recurringParents = await Event.find({
      userId: req.userId,
      recurrence: { $exists: true },
      startDate: { $lte: rangeEnd }
    })
      .sort({ startDate: 1 })
      .lean();

    // Expand occurrences
    const occurrences = recurringParents.flatMap((ev) =>
      expandRecurringEventIntoRange(ev, rangeStart, rangeEnd)
    );

    // Merge and sort
    const combined = [...oneTime, ...occurrences].sort((a, b) => {
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });

    // Reminder enrichment: keep your existing behavior
    // NOTE: occurrences should generally NOT have reminderId in the future, but we won't break anything here.
    const reminderIds = combined.map((e: any) => e.reminderId).filter(Boolean);

    let remindersById = new Map<string, any>();
    if (reminderIds.length) {
      const reminders = await Reminder.find({
        userId: req.userId,
        _id: { $in: reminderIds as any },
        status: { $ne: "deleted" }
      }).lean();

      remindersById = new Map(reminders.map((r) => [String(r._id), r]));
    }

    const enriched = combined.map((e: any) => {
      const rid = e.reminderId ? String(e.reminderId) : null;
      return { ...e, reminder: rid ? remindersById.get(rid) || null : null };
    });

    res.json({ events: enriched });
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// GET /api/miniapp/calendar/events/:id - Get single event
router.get("/events/:id", async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    let reminder = null;
    if (event.reminderId) {
      reminder = await Reminder.findOne({
        _id: event.reminderId,
        userId: req.userId,
        status: { $ne: "deleted" }
      }).lean();
    }

    res.json({ event: { ...event, reminder } });
  } catch (error) {
    console.error("Error fetching event:", error);
    res.status(500).json({ error: "Failed to fetch event" });
  }
});

// POST /api/miniapp/calendar/events - Create new event
router.post("/events", async (req, res) => {
  try {
    const {
      title,
      description,
      startDate,
      endDate,
      allDay,
      color,
      location,
      reminder, // <-- NEW
      recurrence
    } = req.body as any;

    if (!title || !startDate) {
      return res.status(400).json({ error: "title and startDate required" });
    }

    const start = new Date(startDate);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startDate" });
    }

    const event = await Event.create({
      userId: req.userId,
      title,
      description,
      startDate: start,
      endDate: endDate ? new Date(endDate) : undefined,
      allDay: allDay || false,
      color,
      location,
      recurrence: recurrence || undefined
    });

    // Handle optional reminder link
    if (reminder) {
      const payload = reminder as ReminderPayload;
      const nextRunAt = computeReminderNextRunAt({ eventStart: start, reminder: payload });

      // sanity: don't allow reminder time far in the past
      if (payload.enabled && nextRunAt && nextRunAt.getTime() < Date.now() - 30_000) {
        return res.status(400).json({ error: "Reminder time is in the past" });
      }

      /**
       * ===============================
       * CAP CHECK (CREATE)
       * - Only when they're trying to ENABLE a reminder
       * - Only blocks creating a NEW linked reminder
       * - Bypass if owner or premium
       * ===============================
       */
      if (payload.enabled && nextRunAt) {
        const userId = req.userId!;
        const bypass = hasCapBypass(userId) || (await isPremiumActive(userId));

        if (!bypass) {
          const currentCount = await countReminderEvents(userId);
          if (currentCount >= EVENT_REMINDER_CAP) {
            return res.status(403).json({
              error: `Event reminder cap reached (${EVENT_REMINDER_CAP}). Upgrade to Premium to unlock more.`
            });
          }
        }
      }

      const { reminderId } = await upsertEventReminder({
        userId: req.userId!,
        eventId: String(event._id),
        existingReminderId: null,
        eventDataForText: { title, description, location },
        nextRunAt
      });

      // Update event with reminderId if created
      if (reminderId) {
        const updated = await Event.findOneAndUpdate(
          { _id: event._id, userId: req.userId },
          { $set: { reminderId } },
          { new: true }
        ).lean();

        return res.json({ event: updated });
      }
    }

    res.json({ event });
  } catch (error: any) {
    console.error("Error creating event:", error);

    if (String(error?.message || "").includes("DM chat not configured")) {
      return res.status(400).json({ error: "DM chat not configured" });
    }

    res.status(500).json({ error: "Failed to create event" });
  }
});

// PUT /api/miniapp/calendar/events/:id - Update event
router.put("/events/:id", async (req, res) => {
  try {
    const {
      title,
      description,
      startDate,
      endDate,
      allDay,
      color,
      location,
      reminder, // <-- NEW
      recurrence
    } = req.body as any;

    const current = await Event.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!current) {
      return res.status(404).json({ error: "Event not found" });
    }

    const update: any = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (startDate !== undefined) update.startDate = new Date(startDate);
    if (endDate !== undefined) update.endDate = endDate ? new Date(endDate) : null;
    if (allDay !== undefined) update.allDay = allDay;
    if (color !== undefined) update.color = color;
    if (location !== undefined) update.location = location;
    if (recurrence !== undefined) update.recurrence = recurrence || null;

    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: update },
      { new: true }
    ).lean();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Handle optional reminder link
    if (reminder !== undefined) {
      const payload = reminder as ReminderPayload;

      const start = event.startDate ? new Date(event.startDate) : new Date();
      const nextRunAt = computeReminderNextRunAt({ eventStart: start, reminder: payload });

      if (payload.enabled && nextRunAt && nextRunAt.getTime() < Date.now() - 30_000) {
        return res.status(400).json({ error: "Reminder time is in the past" });
      }

      /**
       * ===============================
       * CAP CHECK (UPDATE)
       * Only blocks when:
       * - They're enabling a reminder
       * - AND this event does NOT already have one (event.reminderId is empty)
       * - Bypass if owner or premium
       * ===============================
       */
      if (payload.enabled && nextRunAt && !event.reminderId) {
        const userId = req.userId!;
        const bypass = hasCapBypass(userId) || (await isPremiumActive(userId));

        if (!bypass) {
          const currentCount = await countReminderEvents(userId);
          if (currentCount >= EVENT_REMINDER_CAP) {
            return res.status(403).json({
              error: `Event reminder cap reached (${EVENT_REMINDER_CAP}). Upgrade to Premium to unlock more.`
            });
          }
        }
      }

      const { reminderId } = await upsertEventReminder({
        userId: req.userId!,
        eventId: String(event._id),
        existingReminderId: event.reminderId,
        eventDataForText: {
          title: event.title,
          description: event.description,
          location: event.location
        },
        nextRunAt
      });

      // persist reminderId change (set or clear)
      const updated = await Event.findOneAndUpdate(
        { _id: event._id, userId: req.userId },
        { $set: { reminderId: reminderId || null } },
        { new: true }
      ).lean();

      return res.json({ event: updated });
    }

    res.json({ event });
  } catch (error: any) {
    console.error("Error updating event:", error);

    if (String(error?.message || "").includes("DM chat not configured")) {
      return res.status(400).json({ error: "DM chat not configured" });
    }

    res.status(500).json({ error: "Failed to update event" });
  }
});

// DELETE /api/miniapp/calendar/events/:id - Delete event
router.delete("/events/:id", async (req, res) => {
  try {
    const event = await Event.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // If linked reminder exists, delete it too (soft-delete)
    if (event.reminderId) {
      await Reminder.findOneAndUpdate(
        { _id: event.reminderId, userId: req.userId },
        { $set: { status: "deleted" } },
        { new: true }
      ).lean();
    }

    res.json({ event });
  } catch (error) {
    console.error("Error deleting event:", error);
    res.status(500).json({ error: "Failed to delete event" });
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