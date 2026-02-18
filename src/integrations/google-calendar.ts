import { google } from "googleapis";
import { DateTime } from "luxon";
import { GoogleCalendarLink } from "../models/GoogleCalendarLink";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOAuthClient() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = requireEnv("GOOGLE_REDIRECT_URI");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getGoogleAuthUrl(userId: number) {
  const oauth2 = getOAuthClient();

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      // create/update/delete events
      "https://www.googleapis.com/auth/calendar.events",
      // list calendars + read calendar metadata
      "https://www.googleapis.com/auth/calendar.readonly",
      // get email (nice for status UI)
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    state: String(userId),
  });

  return url;
}

async function fetchGoogleEmail(oauth2: any) {
  try {
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const me = await oauth2Api.userinfo.get();
    return String(me?.data?.email || "");
  } catch {
    return "";
  }
}

export async function handleGoogleCallback(code: string, userId: number) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned. User may need to disconnect and reconnect."
    );
  }

  oauth2.setCredentials(tokens);

  const email = await fetchGoogleEmail(oauth2);

  await GoogleCalendarLink.findOneAndUpdate(
    { userId },
    {
      $set: {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token ?? null,
        expiryDate: tokens.expiry_date ?? null,
        calendarId: "primary",
        email: email || null,
      },
    },
    { upsert: true, new: true }
  ).lean();

  return true;
}

async function getAuthedCalendarClient(userId: number) {
  const link = await GoogleCalendarLink.findOne({ userId }).lean();
  if (!link) return null;

  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    refresh_token: (link as any).refreshToken,
    access_token: (link as any).accessToken ?? undefined,
    expiry_date: (link as any).expiryDate ?? undefined,
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2 });

  return {
    calendar,
    oauth2,
    calendarId: String((link as any).calendarId || "primary"),
    email: String((link as any).email || ""),
  };
}

function toRfc3339(d: Date, tz: string) {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date for tz=${tz}: ${String(d)}`);
  const iso = dt.toISO({ suppressMilliseconds: true });
  if (!iso) throw new Error(`Failed to build ISO for tz=${tz}: ${dt.toString()}`);
  return iso;
}

function weekdayToByDay(n: number) {
  const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return map[Math.min(6, Math.max(0, n))];
}

function buildGoogleRecurrence(rule: any) {
  if (!rule || !rule.freq) return undefined;

  const freq = String(rule.freq).toUpperCase();
  const interval = Math.max(1, Number(rule.interval || 1));

  const parts: string[] = [`FREQ=${freq}`, `INTERVAL=${interval}`];

  if (freq === "WEEKLY" && Array.isArray(rule.byWeekday) && rule.byWeekday.length) {
    const byday = rule.byWeekday
      .map((x: any) => Number(x))
      .filter((x: number) => Number.isFinite(x) && x >= 0 && x <= 6)
      .map(weekdayToByDay);

    if (byday.length) parts.push(`BYDAY=${byday.join(",")}`);
  }

  const end = rule.end;
  if (end?.kind === "count") {
    const c = Number(end.count);
    if (Number.isFinite(c) && c > 0) parts.push(`COUNT=${c}`);
  } else if (end?.kind === "until" && end.until) {
    const until = new Date(end.until);
    if (!isNaN(until.getTime())) {
      const u = DateTime.fromJSDate(until, { zone: "utc" }).toFormat("yyyyMMdd'T'HHmmss'Z'");
      parts.push(`UNTIL=${u}`);
    }
  }

  return [`RRULE:${parts.join(";")}`];
}

export async function googleStatus(userId: number) {
  const link = await GoogleCalendarLink.findOne({ userId }).lean();
  if (!link) {
    return { connected: false, email: "", selectedCalendarId: "" };
  }

  return {
    connected: true,
    email: String((link as any).email || ""),
    selectedCalendarId: String((link as any).calendarId || "primary"),
  };
}

export async function googleDisconnect(userId: number) {
  await GoogleCalendarLink.deleteOne({ userId });
  return true;
}

export async function googleListCalendars(userId: number) {
  const client = await getAuthedCalendarClient(userId);
  if (!client) return { connected: false, calendars: [] as any[] };

  const resp = await client.calendar.calendarList.list();
  const items = Array.isArray(resp.data.items) ? resp.data.items : [];

  const calendars = items.map((c: any) => ({
    id: String(c.id || ""),
    summary: String(c.summary || c.summaryOverride || "(untitled)"),
    primary: !!c.primary,
    accessRole: String(c.accessRole || ""),
  }));

  return { connected: true, calendars };
}

export async function googleSetCalendar(userId: number, calendarId: string) {
  const link = await GoogleCalendarLink.findOne({ userId }).lean();
  if (!link) throw new Error("Not connected");

  await GoogleCalendarLink.updateOne(
    { userId },
    { $set: { calendarId: String(calendarId || "primary") } }
  );

  return true;
}

export async function googleUpsertEvent(args: {
  userId: number;
  event: any;
  tz: string;
}) {
  const client = await getAuthedCalendarClient(args.userId);
  if (!client) return { synced: false, reason: "not_connected" as const };

  const { calendar, calendarId } = client;

  try {
    const e = args.event;

    const title = String(e.title || "(untitled)").trim();
    const description = e.description ? String(e.description) : undefined;
    const location = e.location ? String(e.location) : undefined;
    const recurrence = buildGoogleRecurrence(e.recurrence);

    const body: any = {
      summary: title,
      description,
      location,
      recurrence,
    };

    // -----------------------------
    // DATE HANDLING (SAFE + STRICT)
    // -----------------------------

    if (e.allDay) {
      if (!e.startDate) {
        throw new Error("All-day event missing startDate");
      }

      const startDT = DateTime.fromJSDate(new Date(e.startDate), { zone: args.tz });
      if (!startDT.isValid) {
        throw new Error(`Invalid all-day startDate: ${e.startDate}`);
      }

      const startKey = startDT.toFormat("yyyy-LL-dd");

      let endDT;
      if (e.endDate) {
        const parsedEnd = DateTime.fromJSDate(new Date(e.endDate), { zone: args.tz });
        if (!parsedEnd.isValid) {
          throw new Error(`Invalid all-day endDate: ${e.endDate}`);
        }
        endDT = parsedEnd.plus({ days: 1 });
      } else {
        endDT = startDT.plus({ days: 1 });
      }

      body.start = { date: startKey };
      body.end = { date: endDT.toFormat("yyyy-LL-dd") };

    } else {
      if (!e.startDate) {
        throw new Error("Timed event missing startDate");
      }

      const startDT = DateTime.fromJSDate(new Date(e.startDate), { zone: args.tz });
      if (!startDT.isValid) {
        throw new Error(`Invalid startDate: ${e.startDate}`);
      }

      const startIso = startDT.toISO({ suppressMilliseconds: true });

      let endDT;
      if (e.endDate) {
        const parsedEnd = DateTime.fromJSDate(new Date(e.endDate), { zone: args.tz });
        if (!parsedEnd.isValid) {
          throw new Error(`Invalid endDate: ${e.endDate}`);
        }
        endDT = parsedEnd;
      } else {
        // default duration 30 minutes
        endDT = startDT.plus({ minutes: 30 });
      }

      const endIso = endDT.toISO({ suppressMilliseconds: true });

      body.start = { dateTime: startIso, timeZone: args.tz };
      body.end = { dateTime: endIso, timeZone: args.tz };
    }

    // -----------------------------
    // UPSERT LOGIC
    // -----------------------------

    if (e.googleEventId) {
      const updated = await calendar.events.patch({
        calendarId,
        eventId: String(e.googleEventId),
        requestBody: body,
      });

      return {
        synced: true,
        googleEventId: updated.data.id || String(e.googleEventId),
        googleCalendarId: calendarId,
      };
    }

    const created = await calendar.events.insert({
      calendarId,
      requestBody: body,
    });

    return {
      synced: true,
      googleEventId: created.data.id || null,
      googleCalendarId: calendarId,
    };

  } catch (err: any) {
    console.error("[GCAL] upsert failed", {
      userId: args.userId,
      calendarId,
      eventTitle: args?.event?.title,
      startDate: args?.event?.startDate,
      endDate: args?.event?.endDate,
      allDay: args?.event?.allDay,
      error: err?.message,
      googleError: err?.response?.data || err?.errors || null,
    });

    return {
      synced: false,
      reason: "google_error" as const,
      message: err?.message || "Unknown error",
    };
  }
}

export async function googleBackfillAllEvents(args: {
  userId: number;
  tz: string;
  // pass in a function that loads events, so this file stays decoupled
  loadEvents: (userId: number) => Promise<any[]>;
  // pass in a function that persists google ids back to your DB
  saveGoogleIds: (eventId: any, googleEventId: string, googleCalendarId: string) => Promise<void>;
  // optional: limit for safety
  limit?: number;
}) {
  const client = await getAuthedCalendarClient(args.userId);
  if (!client) return { ok: false, reason: "not_connected" as const };

  const events = await args.loadEvents(args.userId);
  const list = Array.isArray(events) ? events : [];
  const sliced = typeof args.limit === "number" ? list.slice(0, args.limit) : list;

  let success = 0;
  let failed = 0;

  const results: Array<{
    eventId: any;
    title?: string;
    ok: boolean;
    googleEventId?: string | null;
    message?: string;
  }> = [];

  for (const ev of sliced) {
    try {
      const r = await googleUpsertEvent({
        userId: args.userId,
        event: ev,
        tz: args.tz,
      });

      if (r?.synced && r.googleEventId) {
        await args.saveGoogleIds(ev._id ?? ev.id, String(r.googleEventId), String(r.googleCalendarId || client.calendarId));
        success++;
        results.push({ eventId: ev._id ?? ev.id, title: ev.title, ok: true, googleEventId: r.googleEventId });
      } else {
        failed++;
        results.push({ eventId: ev._id ?? ev.id, title: ev.title, ok: false, message: r?.reason || "not_synced" });
      }
    } catch (err: any) {
      failed++;
      console.error("[GCAL] backfill item failed", {
        userId: args.userId,
        eventId: ev._id ?? ev.id,
        title: ev?.title,
        error: err?.message,
        googleError: err?.response?.data || err?.errors || null,
      });
      results.push({ eventId: ev._id ?? ev.id, title: ev.title, ok: false, message: err?.message || "error" });
    }
  }

  return {
    ok: true,
    total: sliced.length,
    success,
    failed,
    results,
  };
}

export async function googleDeleteEvent(args: {
  userId: number;
  googleEventId?: string | null;
  googleCalendarId?: string | null;
}) {
  if (!args.googleEventId) return { deleted: false, reason: "no_google_id" as const };

  const client = await getAuthedCalendarClient(args.userId);
  if (!client) return { deleted: false, reason: "not_connected" as const };

  const calendarId = args.googleCalendarId || client.calendarId;

  await client.calendar.events.delete({
    calendarId,
    eventId: String(args.googleEventId),
  });

  return { deleted: true };
}