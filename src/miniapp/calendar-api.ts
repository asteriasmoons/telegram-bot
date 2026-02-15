// src/miniapp/calendar-api.ts
// Calendar API endpoints (with optional linked reminder support)
// + One-way Google Calendar sync (bot -> Google)

import { Router } from "express";
import mongoose from "mongoose";
import { DateTime } from "luxon";

import { Event } from "../models/Event";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";
import { Premium } from "../models/Premium";

// Google integration helpers (your file)
import { googleUpsertEvent, googleDeleteEvent } from "../integrations/google-calendar";

const router = Router();

/**
 * ===============================
 * CAP SETTINGS + BYPASS
 * ===============================
 */
const EVENT_REMINDER_CAP = 3;

// ✅ OWNER / DEV BYPASS (hardcoded, no env vars)
const CAP_BYPASS_USER_IDS = new Set<number>([
  6382917923, // <-- your Telegram user id
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
    reminderId: { $ne: null },
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
  meetingUrl?: string;
}) {
  const parts: string[] = [];
  parts.push(event.title);

  if (event.description && event.description.trim()) {
    parts.push(event.description.trim());
  }

  if (event.location && event.location.trim()) {
    parts.push(`${event.location.trim()}`);
  }

  if (event.meetingUrl && String(event.meetingUrl).trim()) {
    parts.push(`${String(event.meetingUrl).trim()}`);
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

function computeReminderNextRunAt(args: { eventStart: Date; reminder: ReminderPayload }) {
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

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toTimeOfDayHHmm(d: Date, tz: string) {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  return `${pad2(dt.hour)}:${pad2(dt.minute)}`;
}

function mapRecurrenceToReminderSchedule(args: {
  eventStart: Date;
  tz: string;
  recurrence: any;
  reminderNextRunAt: Date; // first intended reminder timestamp
}) {
  const { eventStart, tz, recurrence, reminderNextRunAt } = args;

  if (!recurrence) return { kind: "once" as const };

  const freq = String(recurrence.freq || "").toLowerCase();
  const interval = Math.max(1, Number(recurrence.interval || 1));

  // Reminder time-of-day should follow reminder timestamp (offset included),
  // NOT always the event start time.
  const timeOfDay = toTimeOfDayHHmm(reminderNextRunAt, tz);

  const daysOfWeek = Array.isArray(recurrence.byWeekday)
    ? recurrence.byWeekday
        .map((x: any) => Number(x))
        .filter((n: number) => Number.isFinite(n) && n >= 0 && n <= 6)
    : [];

  const startZ = DateTime.fromJSDate(eventStart, { zone: tz });

  if (freq === "daily") {
    return { kind: "daily" as const, interval, timeOfDay };
  }

  if (freq === "weekly") {
    return {
      kind: "weekly" as const,
      interval,
      timeOfDay,
      daysOfWeek: daysOfWeek.length ? daysOfWeek : [startZ.weekday % 7],
    };
  }

  if (freq === "monthly") {
    return { kind: "monthly" as const, interval, timeOfDay, anchorDayOfMonth: startZ.day };
  }

  if (freq === "yearly") {
    return {
      kind: "yearly" as const,
      interval,
      timeOfDay,
      anchorMonth: startZ.month,
      anchorDay: startZ.day,
    };
  }

  return { kind: "once" as const };
}

/**
 * Given a schedule and timezone, compute the next run after "now".
 * Mirrors scheduler behavior so stored nextRunAt is never stale.
 */
function computeNextFromScheduleLuxon(args: { schedule: any; tz: string; seed: Date }) {
  const { schedule, tz, seed } = args;

  if (!schedule || schedule.kind === "once") return seed;

  const nowZ = DateTime.now().setZone(tz);
  const candidate = DateTime.fromJSDate(seed, { zone: tz });

  if (candidate > nowZ) return candidate.toJSDate();

  const timeOfDay = String(schedule.timeOfDay || "");
  const m = timeOfDay.match(/^(\d{2}):(\d{2})$/);
  const hour = m ? Number(m[1]) : candidate.hour;
  const minute = m ? Number(m[2]) : candidate.minute;

  if (schedule.kind === "daily") {
    const step = Math.max(1, Number(schedule.interval || 1));
    let c = nowZ.set({ hour, minute, second: 0, millisecond: 0 });
    if (c <= nowZ) c = c.plus({ days: 1 });
    while (c <= nowZ) c = c.plus({ days: step });
    return c.toJSDate();
  }

  if (schedule.kind === "weekly") {
    const step = Math.max(1, Number(schedule.interval || 1));
    const days: number[] = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];

    const target = new Set(
      days
        .map((d) => Number(d))
        .filter((d) => Number.isFinite(d) && d >= 0 && d <= 6)
        .map((d) => (d === 0 ? 7 : d))
    );

    if (target.size === 0) target.add(nowZ.weekday);

    for (let i = 0; i <= 7; i++) {
      const day = nowZ.plus({ days: i });
      if (!target.has(day.weekday)) continue;

      const c = day.set({ hour, minute, second: 0, millisecond: 0 });
      if (c > nowZ) return c.toJSDate();
    }

    return nowZ.plus({ weeks: step }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
  }

  if (schedule.kind === "monthly") {
    const step = Math.max(1, Number(schedule.interval || 1));
    const anchor = Math.max(1, Number(schedule.anchorDayOfMonth || candidate.day));

    const clamp = (dt: DateTime, dayNum: number) => {
      if (!dt.isValid) return dt;
      const dim = dt.daysInMonth ?? 31;
      const safe = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safe });
    };

    let c = clamp(nowZ.set({ hour, minute, second: 0, millisecond: 0 }), anchor);
    if (c <= nowZ) c = clamp(c.plus({ months: 1 }), anchor);
    while (c <= nowZ) c = clamp(c.plus({ months: step }), anchor);

    return c.toJSDate();
  }

  if (schedule.kind === "yearly") {
    const step = Math.max(1, Number(schedule.interval || 1));
    const anchorMonth = Math.min(Math.max(1, Number(schedule.anchorMonth || candidate.month)), 12);
    const anchorDay = Math.max(1, Number(schedule.anchorDay || candidate.day));

    const clamp = (dt: DateTime, dayNum: number) => {
      if (!dt.isValid) return dt;
      const dim = dt.daysInMonth ?? 31;
      const safe = Math.min(Math.max(1, dayNum), dim);
      return dt.set({ day: safe });
    };

    let c = nowZ.set({ month: anchorMonth, hour, minute, second: 0, millisecond: 0 });
    c = clamp(c, anchorDay);

    if (c <= nowZ) {
      c = c.plus({ years: 1 });
      c = clamp(c, anchorDay);
    }

    while (c <= nowZ) {
      c = c.plus({ years: step });
      c = clamp(c, anchorDay);
    }

    return c.toJSDate();
  }

  return candidate.toJSDate();
}

/**
 * Create/update/delete linked reminder for an event.
 */
async function upsertEventReminder(args: {
  userId: number;
  eventId: string;
  existingReminderId?: any;
  eventDataForText: { title: string; description?: string; location?: string; meetingUrl?: string };
  nextRunAt: Date | null;
  eventStart: Date;
  recurrence?: any;
}) {
  const { userId, existingReminderId, eventDataForText, nextRunAt } = args;

  // reminder disabled -> delete linked reminder (soft)
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
  if (!settings?.dmChatId) throw new Error("DM chat not configured");

  const timezone = settings?.timezone || "America/Chicago";
  const text = buildEventReminderText(eventDataForText);

  const schedule = mapRecurrenceToReminderSchedule({
    eventStart: args.eventStart,
    tz: timezone,
    recurrence: args.recurrence,
    reminderNextRunAt: nextRunAt,
  });

  const safeNextRunAt =
    schedule.kind === "once"
      ? nextRunAt
      : computeNextFromScheduleLuxon({ schedule, tz: timezone, seed: nextRunAt });

  if (existingReminderId) {
    const updated = await Reminder.findOneAndUpdate(
      { _id: existingReminderId, userId },
      {
        $set: {
          text,
          nextRunAt: safeNextRunAt,
          schedule,
          timezone,
          status: "scheduled",
        },
      },
      { new: true }
    ).lean();

    if (updated) return { reminderId: updated._id };
  }

  const created = await Reminder.create({
    userId,
    chatId: settings.dmChatId,
    text,
    status: "scheduled",
    nextRunAt: safeNextRunAt,
    schedule,
    timezone,
    lock: {},
  });

  return { reminderId: created._id };
}

function startOfDayKey(d: Date, tz: string) {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-LL-dd");
}

function clampDayOfMonth(year: number, month0: number, desiredDay: number) {
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
    return occurrenceDate.getTime() <= until.getTime();
  }

  return true;
}

function expandRecurringEventIntoRange(event: any, rangeStart: Date, rangeEnd: Date, tz: string) {
  const rule = event.recurrence;
  if (!rule) return [];

  const freq = String(rule.freq || "").toLowerCase();
  const interval = Math.max(1, Number(rule.interval || 1));

  const exceptions = new Set<string>(
    Array.isArray(event.recurrenceExceptions) ? event.recurrenceExceptions : []
  );

  const baseStart = new Date(event.startDate);
  const baseEnd = event.endDate ? new Date(event.endDate) : null;
  const durationMs = baseEnd ? baseEnd.getTime() - baseStart.getTime() : 0;

  const occurrences: any[] = [];
  let current = new Date(baseStart);
  let index = 0;

  // Fast-forward rough
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

  while (current <= rangeEnd) {
    if (!isRecurrenceActiveOnDate(rule, index, current)) break;

    if (freq === "weekly" && byWeekday) {
      const dow = DateTime.fromJSDate(current, { zone: tz }).weekday % 7; // 0..6
      if (!byWeekday.has(dow)) {
        current = addDays(current, 1);
        continue;
      }
    }

    const occStart = new Date(current);
    const occEnd = baseEnd ? new Date(occStart.getTime() + durationMs) : null;

    const key = startOfDayKey(occStart, tz);
    if (!exceptions.has(key)) {
      const overlaps = occEnd
        ? occStart <= rangeEnd && occEnd >= rangeStart
        : occStart >= rangeStart && occStart <= rangeEnd;

      if (overlaps) {
        occurrences.push({
          ...event,
          parentId: event._id,
          occurrenceId: `${String(event._id)}|${occStart.toISOString()}`,
          isOccurrence: true,
          startDate: occStart,
          endDate: occEnd || undefined,
        });
      }
    }

    if (freq === "daily") current = addDays(current, interval);
    else if (freq === "weekly") current = addWeeks(current, interval);
    else if (freq === "monthly") current = addMonthsClamped(current, interval);
    else if (freq === "yearly") current = addYearsClamped(current, interval);
    else break;

    index += 1;
    if (index > 5000) break;
  }

  return occurrences;
}

/**
 * ==========================================================
 * ROUTES
 * ==========================================================
 */

// GET /api/miniapp/calendar/events - Get events for a date range
router.get("/events", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const settings = await UserSettings.findOne({ userId: req.userId }).lean();
    const tz = settings?.timezone || "America/Chicago";

    const startISO = String(startDate);
    const endISO = String(endDate);

    const startZ = DateTime.fromISO(startISO, { zone: tz }).startOf("day");
    const endZ = DateTime.fromISO(endISO, { zone: tz }).endOf("day");

    const rangeStart = startZ.toUTC().toJSDate();
    const rangeEnd = endZ.toUTC().toJSDate();

    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    // 1) one-time
    const oneTime = await Event.find({
      userId: req.userId,
      $or: [{ recurrence: { $exists: false } }, { recurrence: null }],
      $and: [
        { startDate: { $lte: rangeEnd } },
        {
          $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: rangeStart } }],
        },
      ],
    })
      .sort({ startDate: 1 })
      .lean();

    // 2) recurring parents
    const recurringParents = await Event.find({
      userId: req.userId,
      recurrence: { $exists: true, $ne: null },
      startDate: { $lte: rangeEnd },
    })
      .sort({ startDate: 1 })
      .lean();

    const occurrences = recurringParents.flatMap((ev) =>
      expandRecurringEventIntoRange(ev, rangeStart, rangeEnd, tz)
    );

    const combined = [...oneTime, ...occurrences].sort((a, b) => {
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });

    // Reminder enrichment
    const reminderIds = combined.map((e: any) => e.reminderId).filter(Boolean);

    let remindersById = new Map<string, any>();
    if (reminderIds.length) {
      const reminders = await Reminder.find({
        userId: req.userId,
        _id: { $in: reminderIds as any },
        status: { $ne: "deleted" },
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
      userId: req.userId,
    }).lean();

    if (!event) return res.status(404).json({ error: "Event not found" });

    let reminder = null;
    if (event.reminderId) {
      reminder = await Reminder.findOne({
        _id: event.reminderId,
        userId: req.userId,
        status: { $ne: "deleted" },
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
    console.log("CALENDAR PAYLOAD:", JSON.stringify(req.body, null, 2));

    const {
      title,
      description,
      startDate,
      endDate,
      allDay,
      color,
      meetingUrl,
      location,
      locationPlaceId,
      locationCoords,
      reminder,
      recurrence,
    } = req.body as any;

    if (!title || !startDate) {
      return res.status(400).json({ error: "title and startDate required" });
    }

    const start = new Date(startDate);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startDate" });
    }

    let end: Date | undefined = undefined;
    if (endDate !== undefined) {
      if (!endDate) {
        end = undefined;
      } else {
        const ed = new Date(endDate);
        if (isNaN(ed.getTime())) return res.status(400).json({ error: "Invalid endDate" });
        end = ed;
      }
    }

    const event = await Event.create({
      userId: req.userId,
      title,
      description,
      startDate: start,
      endDate: end,
      allDay: allDay || false,
      color,
      meetingUrl: meetingUrl ? String(meetingUrl).trim() : "",
      location,
      locationPlaceId: locationPlaceId || null,
      locationCoords: locationCoords || null,
      recurrence: recurrence || undefined,
    });

    // --- GOOGLE SYNC (one-way) AFTER we have `event` ---
    try {
      const settings = await UserSettings.findOne({ userId: req.userId }).lean();
      const tz = settings?.timezone || "America/Chicago";

      const syncRes = await googleUpsertEvent({ userId: req.userId!, event, tz });

      if (syncRes?.synced && syncRes.googleEventId) {
        await Event.updateOne(
          { _id: event._id, userId: req.userId },
          { $set: { googleEventId: syncRes.googleEventId, googleCalendarId: syncRes.googleCalendarId } }
        );
      }
    } catch (e: any) {
      console.warn("Google sync (create) failed:", e?.message || e);
    }

    // Handle optional reminder link
    if (reminder) {
      const payload = reminder as ReminderPayload;
      const nextRunAt = computeReminderNextRunAt({ eventStart: start, reminder: payload });

      if (payload.enabled && nextRunAt && nextRunAt.getTime() < Date.now() - 30_000) {
        return res.status(400).json({ error: "Reminder time is in the past" });
      }

      if (payload.enabled && nextRunAt) {
        const userId = req.userId!;
        const bypass = hasCapBypass(userId) || (await isPremiumActive(userId));

        if (!bypass) {
          const currentCount = await countReminderEvents(userId);
          if (currentCount >= EVENT_REMINDER_CAP) {
            return res.status(403).json({
              error: `Event reminder cap reached (${EVENT_REMINDER_CAP}). Upgrade to Premium to unlock more.`,
            });
          }
        }
      }

      const { reminderId } = await upsertEventReminder({
        userId: req.userId!,
        eventId: String(event._id),
        existingReminderId: null,
        eventDataForText: { title, description, meetingUrl, location },
        nextRunAt,
        eventStart: start,
        recurrence: recurrence || undefined,
      });

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
    console.log("CALENDAR PAYLOAD:", JSON.stringify(req.body, null, 2));

    const {
      title,
      description,
      startDate,
      endDate,
      allDay,
      color,
      meetingUrl,
      location,
      locationPlaceId,
      locationCoords,
      reminder,
      recurrence,
    } = req.body as any;

    const current = await Event.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).lean();

    if (!current) return res.status(404).json({ error: "Event not found" });

    const $set: any = {};
    const $unset: any = {};

    if (title !== undefined) $set.title = title;
    if (description !== undefined) $set.description = description;

    if (startDate !== undefined) {
      const sd = new Date(startDate);
      if (isNaN(sd.getTime())) return res.status(400).json({ error: "Invalid startDate" });
      $set.startDate = sd;
    }

    if (endDate !== undefined) {
      if (!endDate) $set.endDate = null;
      else {
        const ed = new Date(endDate);
        if (isNaN(ed.getTime())) return res.status(400).json({ error: "Invalid endDate" });
        $set.endDate = ed;
      }
    }

    if (allDay !== undefined) $set.allDay = allDay;
    if (color !== undefined) $set.color = color;
    if (meetingUrl !== undefined) $set.meetingUrl = meetingUrl ? String(meetingUrl).trim() : "";
    if (location !== undefined) $set.location = location;
    if (locationPlaceId !== undefined) $set.locationPlaceId = locationPlaceId || null;
    if (locationCoords !== undefined) $set.locationCoords = locationCoords || null;

    if (recurrence !== undefined) {
      if (recurrence) $set.recurrence = recurrence;
      else $unset.recurrence = "";
    }

    const updateDoc: any = {};
    if (Object.keys($set).length) updateDoc.$set = $set;
    if (Object.keys($unset).length) updateDoc.$unset = $unset;

    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      updateDoc,
      { new: true }
    ).lean();

    if (!event) return res.status(404).json({ error: "Event not found" });

    // --- GOOGLE SYNC (one-way) AFTER `event` exists ---
    try {
      const settings = await UserSettings.findOne({ userId: req.userId }).lean();
      const tz = settings?.timezone || "America/Chicago";

      const syncRes = await googleUpsertEvent({ userId: req.userId!, event, tz });

      if (
        syncRes?.synced &&
        syncRes.googleEventId &&
        String((event as any).googleEventId || "") !== String(syncRes.googleEventId)
      ) {
        await Event.updateOne(
          { _id: (event as any)._id, userId: req.userId },
          { $set: { googleEventId: syncRes.googleEventId, googleCalendarId: syncRes.googleCalendarId } }
        );
      }
    } catch (e: any) {
      console.warn("Google sync (update) failed:", e?.message || e);
    }

    // Handle optional reminder link
    if (reminder !== undefined) {
      const payload = reminder as ReminderPayload;
      const start = event.startDate ? new Date(event.startDate) : new Date();
      const nextRunAt = computeReminderNextRunAt({ eventStart: start, reminder: payload });

      if (payload.enabled && nextRunAt && nextRunAt.getTime() < Date.now() - 30_000) {
        return res.status(400).json({ error: "Reminder time is in the past" });
      }

      if (payload.enabled && nextRunAt && !(event as any).reminderId) {
        const userId = req.userId!;
        const bypass = hasCapBypass(userId) || (await isPremiumActive(userId));

        if (!bypass) {
          const currentCount = await countReminderEvents(userId);
          if (currentCount >= EVENT_REMINDER_CAP) {
            return res.status(403).json({
              error: `Event reminder cap reached (${EVENT_REMINDER_CAP}). Upgrade to Premium to unlock more.`,
            });
          }
        }
      }

      const { reminderId } = await upsertEventReminder({
        userId: req.userId!,
        eventId: String((event as any)._id),
        existingReminderId: (event as any).reminderId,
        eventDataForText: {
          title: (event as any).title,
          description: (event as any).description,
          location: (event as any).location,
          meetingUrl: (event as any).meetingUrl,
        },
        nextRunAt,
        eventStart: start,
        recurrence: (event as any).recurrence || undefined,
      });

      const updated = await Event.findOneAndUpdate(
        { _id: (event as any)._id, userId: req.userId },
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
      userId: req.userId,
    }).lean();

    if (!event) return res.status(404).json({ error: "Event not found" });

    // --- GOOGLE SYNC (one-way) only AFTER we know event exists ---
    try {
      await googleDeleteEvent({
        userId: req.userId!,
        googleEventId: (event as any).googleEventId,
        googleCalendarId: (event as any).googleCalendarId,
      });
    } catch (e: any) {
      console.warn("Google sync (delete) failed:", e?.message || e);
    }

    // If linked reminder exists, delete it too (soft-delete)
    if ((event as any).reminderId) {
      await Reminder.findOneAndUpdate(
        { _id: (event as any).reminderId, userId: req.userId },
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