import http from "http";
import jwt from "jsonwebtoken";
import { DateTime } from "luxon";
import { Reminder } from "../models/Reminder";
import { sendJson, sendText, normalizePath, readJson } from "../server/router";

function getBearerToken(req: http.IncomingMessage) {
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

function verifyMiniAppToken(token: string) {
  const secret = process.env.MINIAPP_JWT_SECRET;
  if (!secret) throw new Error("Missing MINIAPP_JWT_SECRET");
  return jwt.verify(token, secret) as any;
}

async function requireUserId(req: http.IncomingMessage, res: http.ServerResponse): Promise<number | null> {
  const tok = getBearerToken(req);
  if (!tok) {
    sendJson(res, 401, { ok: false, error: "Missing token" });
    return null;
  }

  try {
    const payload: any = verifyMiniAppToken(tok);
    const userId = Number(payload?.userId);
    if (!Number.isFinite(userId)) {
      sendJson(res, 401, { ok: false, error: "Invalid token payload" });
      return null;
    }
    return userId;
  } catch {
    sendJson(res, 401, { ok: false, error: "Invalid token" });
    return null;
  }
}

function parseIdFromPath(url: string) {
  // /api/reminders/<id>/...
  const parts = url.split("/").filter(Boolean); // ["api","reminders",":id", ...]
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "reminders") {
    return parts[2];
  }
  return null;
}

function computeNextRunAtFromParts(tz: string, dateISO: string, timeHHMM: string) {
  const dt = DateTime.fromISO(`${dateISO}T${timeHHMM}`, { zone: tz });
  return dt.isValid ? dt.toJSDate() : null;
}

function normalizeSchedule(kind: any, tz: string, currentNextRunAt: Date, intervalMinutes?: number) {
  if (kind === "daily") {
    const t = DateTime.fromJSDate(currentNextRunAt, { zone: tz }).toFormat("HH:mm");
    return { kind: "daily", timeOfDay: t };
  }

  if (kind === "weekly") {
    const dt = DateTime.fromJSDate(currentNextRunAt, { zone: tz });
    const t = dt.toFormat("HH:mm");
    const dow = dt.weekday % 7; // Sun=0..Sat=6
    return { kind: "weekly", timeOfDay: t, daysOfWeek: [dow] };
  }

  if (kind === "interval") {
    const mins = Number(intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return { kind: "interval", intervalMinutes: mins };
  }

  // once
  return { kind: "once" };
}

export function makeRemindersApiRoutes() {
  return async function remindersApiRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    // GET /api/reminders  -> scheduled only
    if (url === "/api/reminders" && method === "GET") {
      const userId = await requireUserId(req, res);
      if (!userId) return;

      const reminders = await Reminder.find({
        userId,
        status: "scheduled"
      })
        .sort({ nextRunAt: 1 })
        .limit(200)
        .lean();

      sendJson(res, 200, { ok: true, reminders });
      return;
    }

    // Everything below expects /api/reminders/:id/...
    if (!url.startsWith("/api/reminders/")) {
      sendText(res, 404, "Not found");
      return;
    }

    const userId = await requireUserId(req, res);
    if (!userId) return;

    const id = parseIdFromPath(url);
    if (!id) {
      sendJson(res, 400, { ok: false, error: "Missing reminder id" });
      return;
    }

    // POST /api/reminders/:id/done  -> status = sent
    if (url === `/api/reminders/${id}/done` && method === "POST") {
      const result = await Reminder.updateOne(
        { _id: id, userId, status: "scheduled" },
        { $set: { status: "sent", lastRunAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        sendJson(res, 404, { ok: false, error: "Reminder not found (or not scheduled)" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/reminders/:id/delete  -> status = deleted
    if (url === `/api/reminders/${id}/delete` && method === "POST") {
      const result = await Reminder.updateOne(
        { _id: id, userId },
        { $set: { status: "deleted" } }
      );

      if (result.matchedCount === 0) {
        sendJson(res, 404, { ok: false, error: "Reminder not found" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/reminders/:id/snooze  body: { minutes: number }
    if (url === `/api/reminders/${id}/snooze` && method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const minutes = Number(body?.minutes);

      if (!Number.isFinite(minutes) || minutes <= 0) {
        sendJson(res, 400, { ok: false, error: "minutes must be a positive number" });
        return;
      }

      const result = await Reminder.updateOne(
        { _id: id, userId, status: "scheduled" },
        { $set: { nextRunAt: new Date(Date.now() + minutes * 60_000), status: "scheduled" } }
      );

      if (result.matchedCount === 0) {
        sendJson(res, 404, { ok: false, error: "Reminder not found (or not scheduled)" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/reminders/:id/pause  -> status = paused
    if (url === `/api/reminders/${id}/pause` && method === "POST") {
      const result = await Reminder.updateOne(
        { _id: id, userId, status: "scheduled" },
        { $set: { status: "paused" } }
      );

      if (result.matchedCount === 0) {
        sendJson(res, 404, { ok: false, error: "Reminder not found (or not scheduled)" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/reminders/:id/resume  -> status = scheduled
    if (url === `/api/reminders/${id}/resume` && method === "POST") {
      const rem = await Reminder.findOne({ _id: id, userId }).lean();
      if (!rem) {
        sendJson(res, 404, { ok: false, error: "Reminder not found" });
        return;
      }

      // If nextRunAt is in the past, push it 1 minute forward to avoid immediate spam.
      const nextRunAt = rem.nextRunAt && new Date(rem.nextRunAt).getTime() < Date.now()
        ? new Date(Date.now() + 60_000)
        : rem.nextRunAt;

      await Reminder.updateOne(
        { _id: id, userId },
        { $set: { status: "scheduled", nextRunAt } }
      );

      sendJson(res, 200, { ok: true });
      return;
    }

    // PUT /api/reminders/:id
    // body supports:
    // { text?: string, dateISO?: "YYYY-MM-DD", timeHHMM?: "HH:MM", frequency?: "once"|"daily"|"weekly"|"interval", intervalMinutes?: number }
    //
    // NOTE: Editing text from the web app cannot preserve Telegram message entities reliably.
    // We will clear entities when text changes.
    if (url === `/api/reminders/${id}` && method === "PUT") {
      const body = await readJson(req).catch(() => ({}));

      const rem = await Reminder.findOne({ _id: id, userId }).lean();
      if (!rem) {
        sendJson(res, 404, { ok: false, error: "Reminder not found" });
        return;
      }

      const tz = String(rem.timezone || "America/Chicago");

      const patch: any = {};
      let nextRunAt: Date | null = null;

      // Update message text (clear entities)
      if (typeof body.text === "string") {
        const t = body.text.trim();
        if (!t) {
          sendJson(res, 400, { ok: false, error: "text cannot be empty" });
          return;
        }
        patch.text = t;
        patch.entities = undefined;
      }

      // Update date/time
      const dateISO = typeof body.dateISO === "string" ? body.dateISO.trim() : "";
      const timeHHMM = typeof body.timeHHMM === "string" ? body.timeHHMM.trim() : "";

      if (dateISO || timeHHMM) {
        const current = DateTime.fromJSDate(new Date(rem.nextRunAt), { zone: tz });
        const finalDate = dateISO || (current.isValid ? current.toFormat("yyyy-LL-dd") : DateTime.now().setZone(tz).toFormat("yyyy-LL-dd"));
        const finalTime = timeHHMM || (current.isValid ? current.toFormat("HH:mm") : "09:00");

        nextRunAt = computeNextRunAtFromParts(tz, finalDate, finalTime);
        if (!nextRunAt) {
          sendJson(res, 400, { ok: false, error: "Invalid date/time" });
          return;
        }
        patch.nextRunAt = nextRunAt;
      }

      // Update frequency
      if (body.frequency) {
        const freq = String(body.frequency);
        const schedule = normalizeSchedule(freq, tz, nextRunAt || new Date(rem.nextRunAt), body.intervalMinutes);
        if (!schedule) {
          sendJson(res, 400, { ok: false, error: "Invalid intervalMinutes" });
          return;
        }
        patch.schedule = schedule;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: patch });
      const updated = await Reminder.findOne({ _id: id, userId }).lean();

      sendJson(res, 200, { ok: true, reminder: updated });
      return;
    }

    sendText(res, 404, "Not found");
  };
}