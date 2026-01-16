import { DateTime } from "luxon";

export function parseISODate(input: string): { ok: true; iso: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  const dt = DateTime.fromISO(trimmed, { zone: "utc" });
  if (!dt.isValid) return { ok: false, error: "Invalid date. Use YYYY-MM-DD." };
  // Ensure it's exactly date-like
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false, error: "Use YYYY-MM-DD (example: 2026-01-16)." };
  return { ok: true, iso: trimmed };
}

export function parseTimeHHMM(input: string): { ok: true; hh: number; mm: number; hhmm: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return { ok: false, error: "Invalid time. Use HH:MM (example: 09:30)." };
  const [hStr, mStr] = trimmed.split(":");
  const hh = Number(hStr);
  const mm = Number(mStr);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return { ok: false, error: "Invalid time. Use HH:MM." };
  if (hh < 0 || hh > 23) return { ok: false, error: "Hour must be 00–23." };
  if (mm < 0 || mm > 59) return { ok: false, error: "Minutes must be 00–59." };
  return { ok: true, hh, mm, hhmm: trimmed };
}

export function computeNextRunAt(params: {
  timezone: string;
  dateISO: string; // "YYYY-MM-DD"
  timeHHMM: string; // "HH:MM"
}): Date {
  const { timezone, dateISO, timeHHMM } = params;
  const [hhStr, mmStr] = timeHHMM.split(":");
  const hh = Number(hhStr);
  const mm = Number(mmStr);

  const dt = DateTime.fromISO(dateISO, { zone: timezone })
    .set({ hour: hh, minute: mm, second: 0, millisecond: 0 });

  // If Luxon considers this invalid, fall back to UTC interpretation
  if (!dt.isValid) {
    const fallback = DateTime.fromISO(`${dateISO}T${timeHHMM}:00`, { zone: "utc" });
    return fallback.toJSDate();
  }

  return dt.toJSDate();
}

export function humanizeWhen(params: { timezone: string; dateISO: string; timeHHMM: string }): string {
  const { timezone, dateISO, timeHHMM } = params;
  const dt = DateTime.fromISO(dateISO, { zone: timezone }).set({
    hour: Number(timeHHMM.slice(0, 2)),
    minute: Number(timeHHMM.slice(3, 5)),
    second: 0,
    millisecond: 0
  });

  if (!dt.isValid) return `${dateISO} ${timeHHMM}`;
  return dt.toFormat("ccc, LLL d yyyy 'at' HH:mm");
}

export function nowInZone(timezone: string): DateTime {
  return DateTime.now().setZone(timezone);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}