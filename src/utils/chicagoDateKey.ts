const TZ = "America/Chicago";

export function chicagoDateKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

  const y = get("year");
  const m = get("month");
  const d = get("day");

  // YYYY-MM-DD
  return `${y}-${m}-${d}`;
}