import { Router } from "express";
import { Event } from "../models/Event";
import { UserSettings } from "../models/UserSettings";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  googleStatus,
  googleDisconnect,
  googleListCalendars,
  googleSetCalendar,
  googleBackfillAllEvents,
} from "../integrations/google-calendar";
import { DateTime } from "luxon";

const router = Router();

/**
 * GOOGLE CONNECT
 * Your frontend calls /cal/google/auth
 * Your earlier backend used /google/connect
 * We support BOTH so you don’t have to chase strings.
 */

// GET /api/miniapp/cal/google/auth  (alias)
router.get("/google/auth", async (req, res) => {
  try {
    const userId = req.userId!;
    const url = getGoogleAuthUrl(userId);
    return res.json({ url });
  } catch (err: any) {
    console.error("google auth error:", err.message);
    return res.status(500).json({ error: "Failed to start Google auth" });
  }
});

// GET /api/miniapp/cal/google/connect (same as auth)
router.get("/google/connect", async (req, res) => {
  try {
    const userId = req.userId!;
    const url = getGoogleAuthUrl(userId);
    return res.json({ url });
  } catch (err: any) {
    console.error("google connect error:", err.message);
    return res.status(500).json({ error: "Failed to start Google connect" });
  }
});

// GET /api/miniapp/cal/google/callback?code=...&state=...
router.get("/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    const userIdFromState = Number(state);
    if (!code || !Number.isFinite(userIdFromState)) {
      return res.status(400).send("Missing code/state");
    }

    await handleGoogleCallback(code, userIdFromState);

    return res.status(200).send("Google Calendar connected. You can return to the mini app.");
  } catch (err: any) {
    console.error("google callback error:", err.message);
    return res.status(500).send("Failed to connect Google Calendar");
  }
});

// GET /api/miniapp/cal/google/status
router.get("/google/status", async (req, res) => {
  try {
    const userId = req.userId!;
    const st = await googleStatus(userId);
    return res.json(st);
  } catch (err: any) {
    console.error("google status error:", err.message);
    return res.status(500).json({ error: "Failed to load status" });
  }
});

// GET /api/miniapp/cal/google/calendars
router.get("/google/calendars", async (req, res) => {
  try {
    const userId = req.userId!;
    const out = await googleListCalendars(userId);
    return res.json(out);
  } catch (err: any) {
    console.error("google calendars error:", err.message);
    return res.status(500).json({ error: "Failed to load calendars" });
  }
});

// PUT /api/miniapp/cal/google/calendar  body: { calendarId }
router.put("/google/calendar", async (req, res) => {
  try {
    const userId = req.userId!;
    const calendarId = String(req.body?.calendarId || "");

    if (!calendarId) {
      return res.status(400).json({ error: "calendarId required" });
    }

    await googleSetCalendar(userId, calendarId);
    return res.json({ ok: true, selectedCalendarId: calendarId });
  } catch (err: any) {
    console.error("google set calendar error:", err.message);
    return res.status(500).json({ error: "Failed to save selected calendar" });
  }
});

// POST /api/miniapp/cal/google/disconnect
router.post("/google/disconnect", async (req, res) => {
  try {
    const userId = req.userId!;
    await googleDisconnect(userId);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("google disconnect error:", err.message);
    return res.status(500).json({ error: "Failed to disconnect" });
  }
});

/**
 * iOS calendar button (.ics download)
 * GET /api/miniapp/cal/ical/:eventId
 */
router.get("/ical/:eventId", async (req, res) => {
  try {
    const userId = req.userId!;
    const event = await Event.findOne({ _id: req.params.eventId, userId }).lean();
    if (!event) return res.status(404).send("Not found");

    const settings = await UserSettings.findOne({ userId }).lean();
    const tz = settings?.timezone || "America/Chicago";

    const uid = `${String(event._id)}@lystaria`;
    const dtstamp = DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'");

    const title = String(event.title || "(untitled)").replace(/\r?\n/g, " ").trim();
    const desc = String(event.description || "").trim();
    const loc = String((event as any).location || "").trim();

    const lines: string[] = [];
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("PRODID:-//Lystaria//Calendar//EN");
    lines.push("CALSCALE:GREGORIAN");
    lines.push("METHOD:PUBLISH");
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);

    if ((event as any).allDay) {
      const startKey = DateTime.fromJSDate(new Date((event as any).startDate), { zone: tz }).toFormat("yyyyMMdd");
      lines.push(`DTSTART;VALUE=DATE:${startKey}`);

      const endKey = (event as any).endDate
        ? DateTime.fromJSDate(new Date((event as any).endDate), { zone: tz }).plus({ days: 1 }).toFormat("yyyyMMdd")
        : DateTime.fromJSDate(new Date((event as any).startDate), { zone: tz }).plus({ days: 1 }).toFormat("yyyyMMdd");

      lines.push(`DTEND;VALUE=DATE:${endKey}`);
    } else {
      const startUtc = DateTime.fromJSDate(new Date((event as any).startDate), { zone: tz })
        .toUTC()
        .toFormat("yyyyMMdd'T'HHmmss'Z'");

      const endUtc = (event as any).endDate
        ? DateTime.fromJSDate(new Date((event as any).endDate), { zone: tz }).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")
        : startUtc;

      lines.push(`DTSTART:${startUtc}`);
      lines.push(`DTEND:${endUtc}`);
    }

    lines.push(`SUMMARY:${title}`);
    if (desc) lines.push(`DESCRIPTION:${desc.replace(/\r?\n/g, "\\n")}`);
    if (loc) lines.push(`LOCATION:${loc}`);

    // Optional RRULE export
    if ((event as any).recurrence?.freq) {
      const r = (event as any).recurrence;
      const freq = String(r.freq).toUpperCase();
      const interval = Math.max(1, Number(r.interval || 1));

      const parts: string[] = [`FREQ=${freq}`, `INTERVAL=${interval}`];

      if (freq === "WEEKLY" && Array.isArray(r.byWeekday) && r.byWeekday.length) {
        const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
        const byday = r.byWeekday
          .map((n: any) => Number(n))
          .filter((n: number) => Number.isFinite(n) && n >= 0 && n <= 6)
          .map((n: number) => map[n]);

        if (byday.length) parts.push(`BYDAY=${byday.join(",")}`);
      }

      const end = r.end;
      if (end?.kind === "count") {
        const c = Number(end.count);
        if (Number.isFinite(c) && c > 0) parts.push(`COUNT=${c}`);
      } else if (end?.kind === "until" && end.until) {
        const u = new Date(end.until);
        if (!isNaN(u.getTime())) {
          const until = DateTime.fromJSDate(u, { zone: "utc" }).toFormat("yyyyMMdd'T'HHmmss'Z'");
          parts.push(`UNTIL=${until}`);
        }
      }

      lines.push(`RRULE:${parts.join(";")}`);
    }

    lines.push("END:VEVENT");
    lines.push("END:VCALENDAR");

    const ics = lines.join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="event-${String((event as any)._id)}.ics"`);
    return res.send(ics);
  } catch (err: any) {
    console.error("ical error:", err.message);
    return res.status(500).send("Failed to create iCal");
  }
});

// POST BACKFILL
router.post("/api/miniapp/cal/google/backfill", requireMiniAppAuth, async (req, res) => {
  try {
    const userId = req.user.id; // however you store it
    const tz = String(req.body?.tz || "America/Chicago");

    const result = await googleBackfillAllEvents({
      userId,
      tz,
      loadEvents: async (uid) => {
        // load ALL events for this user
        return await Event.find({ userId: uid }).lean();
      },
      saveGoogleIds: async (eventId, googleEventId, googleCalendarId) => {
        await Event.updateOne(
          { _id: eventId },
          { $set: { googleEventId, googleCalendarId } }
        );
      },
    });

    res.json(result);
  } catch (e: any) {
    console.error("[GCAL] backfill failed", e);
    res.status(500).json({ ok: false, message: e?.message || "Backfill failed" });
  }
});

export default router;

// Express typing
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}