// src/miniapp/eventShare-api.ts
import { Router } from "express";
import crypto from "crypto";
import { Event } from "../models/Event";
import { EventShare } from "../models/EventShare";
import { EventAttendee } from "../models/EventAttendee";

const router = Router();

/**
 * Helpers
 */
function makeToken() {
  return crypto.randomBytes(16).toString("hex"); // short + human-shareable
}

/**
 * =========================================================
 * JOIN EVENT BY SHARE CODE
 * POST /api/miniapp/eventShare/join
 * body: { token }
 * =========================================================
 */
router.post("/join", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    const share = await EventShare.findOne({ token }).lean();
    if (!share) {
      return res.status(404).json({ error: "Invalid share code" });
    }

    // Load event
    const event = await Event.findById(share.eventId).lean();
    if (!event) {
      return res.status(404).json({ error: "Event no longer exists" });
    }

    // Owner cannot join their own event
    if (event.userId === userId) {
      return res.status(400).json({ error: "You already own this event" });
    }

    // Upsert attendee
    const attendee = await EventAttendee.findOneAndUpdate(
      { eventId: event._id, userId },
      {
        $setOnInsert: {
          eventId: event._id,
          userId,
          rsvp: "going",
          joinedAt: new Date(),
        },
      },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      joined: true,
      rsvp: attendee?.rsvp ?? "going",
      event: {
        id: String(event._id),
        title: event.title,
        description: event.description,
        startDate: event.startDate,
        endDate: event.endDate,
        allDay: event.allDay,
        color: event.color,
        location: event.location,
        recurrence: event.recurrence,
      },
    });
  } catch (err) {
    console.error("Join event failed:", err);
    return res.status(500).json({ error: "Failed to join event" });
  }
});

/**
 * =========================================================
 * GET MY JOINED EVENTS
 * GET /api/miniapp/eventShare/joined/list
 * =========================================================
 */
router.get("/joined/list", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const joins = await EventAttendee.find({ userId })
      .sort({ joinedAt: -1 })
      .lean();

    const eventIds = joins.map((j) => j.eventId);

    const events = await Event.find({ _id: { $in: eventIds } }).lean();

    return res.json({
      events: events.map((e) => ({
        id: String(e._id),
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        allDay: e.allDay,
        color: e.color,
        location: e.location,
      })),
    });
  } catch (err) {
    console.error("Fetch joined events failed:", err);
    return res.status(500).json({ error: "Failed to load joined events" });
  }
});

/**
 * =========================================================
 * UPDATE RSVP
 * POST /api/miniapp/eventShare/:eventId/rsvp
 * body: { rsvp: "going" | "maybe" | "declined" }
 * =========================================================
 */
router.post("/:eventId/rsvp", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { eventId } = req.params;
    const rsvp = String(req.body?.rsvp || "").toLowerCase();

    if (!["going", "maybe", "declined"].includes(rsvp)) {
      return res.status(400).json({ error: "Invalid RSVP value" });
    }

    const attendee = await EventAttendee.findOneAndUpdate(
      { eventId, userId },
      { $set: { rsvp } },
      { new: true }
    ).lean();

    if (!attendee) {
      return res.status(404).json({ error: "You have not joined this event" });
    }

    return res.json({ ok: true, rsvp });
  } catch (err) {
    console.error("RSVP update failed:", err);
    return res.status(500).json({ error: "Failed to update RSVP" });
  }
});

/**
 * =========================================================
 * CREATE SHARE CODE
 * POST /api/miniapp/eventShare/:eventId
 * =========================================================
 */
router.post("/:eventId", async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { eventId } = req.params;

    const event = await Event.findOne({ _id: eventId, userId }).lean();
    if (!event) {
      return res.status(404).json({ error: "Event not found or not owned by you" });
    }

    const token = makeToken();

    const share = await EventShare.create({
      eventId: event._id,
      ownerUserId: userId,
      token,
    });

    return res.json({
      token: share.token,
      eventId: String(event._id),
    });
  } catch (err) {
    console.error("Create event share failed:", err);
    return res.status(500).json({ error: "Failed to create share link" });
  }
});

export default router;

/**
 * Express type augmentation (matches your pattern)
 */
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}