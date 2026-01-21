// src/miniapp/calendar-api.ts
// Calendar API endpoints (with optional linked reminder support)

import { Router } from "express";
import { Event } from "../models/Event";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";

const router = Router();

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

// GET /api/miniapp/calendar/events - Get events for a date range
router.get("/events", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required" });
    }

    const events = await Event.find({
      userId: req.userId,
      startDate: {
        $gte: new Date(startDate as string),
        $lte: new Date(endDate as string)
      }
    })
      .sort({ startDate: 1 })
      .lean();

    // Optional but useful: attach reminder info for UI
    const reminderIds = events
      .map(e => e.reminderId)
      .filter(Boolean);

    let remindersById = new Map<string, any>();
    if (reminderIds.length) {
      const reminders = await Reminder.find({
        userId: req.userId,
        _id: { $in: reminderIds as any },
        status: { $ne: "deleted" }
      }).lean();

      remindersById = new Map(reminders.map(r => [String(r._id), r]));
    }

    const enriched = events.map(e => {
      const rid = e.reminderId ? String(e.reminderId) : null;
      return {
        ...e,
        reminder: rid ? remindersById.get(rid) || null : null
      };
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
      reminder // <-- NEW
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
      location
    });

    // Handle optional reminder link
    if (reminder) {
      const payload = reminder as ReminderPayload;
      const nextRunAt = computeReminderNextRunAt({ eventStart: start, reminder: payload });

      // sanity: don't allow reminder time far in the past
      if (payload.enabled && nextRunAt && nextRunAt.getTime() < Date.now() - 30_000) {
        return res.status(400).json({ error: "Reminder time is in the past" });
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
      reminder // <-- NEW
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