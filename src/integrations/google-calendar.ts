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
  return DateTime.fromJSDate(d, { zone: tz }).toISO({ suppressMilliseconds: true });
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

  if (e.allDay) {
    const startKey = DateTime.fromJSDate(new Date(e.startDate), { zone: args.tz }).toFormat("yyyy-LL-dd");
    const endKey = e.endDate
      ? DateTime.fromJSDate(new Date(e.endDate), { zone: args.tz }).toFormat("yyyy-LL-dd")
      : startKey;

    body.start = { date: startKey };
    body.end = { date: DateTime.fromISO(endKey, { zone: args.tz }).plus({ days: 1 }).toFormat("yyyy-LL-dd") };
  } else {
    const startIso = toRfc3339(new Date(e.startDate), args.tz);
    const endIso = e.endDate ? toRfc3339(new Date(e.endDate), args.tz) : startIso;

    body.start = { dateTime: startIso, timeZone: args.tz };
    body.end = { dateTime: endIso, timeZone: args.tz };
  }

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