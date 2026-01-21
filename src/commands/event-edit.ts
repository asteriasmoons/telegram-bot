import { Telegraf, Markup } from "telegraf";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import { updateEvent } from "../services/events.service";

/**
 * /eventedit
 * Button-driven edit flow (Luxon TZ-safe)
 * - Pick event (buttons + paging)
 * - Edit fields via buttons
 * - Optional linked reminder (None / At event time / Custom date+time)
 * - Reminder text includes FULL description
 */

type ReminderMode = "none" | "at_event_time" | "custom_time";

type Step =
  | "pick_event"
  | "menu"
  | "title"
  | "date"
  | "time"
  | "description"
  | "location"
  | "color"
  | "reminder_pick"
  | "reminder_date"
  | "reminder_time"
  | "reminder_confirm"
  | "confirm_save";

type EditDraft = {
  title?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  allDay?: boolean;
  description?: string;
  location?: string;
  color?: string;

  reminderMode?: ReminderMode;
  reminderDate?: string;
  reminderTime?: string;
  allDayReminderTime?: string;
};

type FlowState = {
  step: Step;
  eventId?: string;
  page?: number;
  draft: EditDraft;
  expect?:
    | "title"
    | "date"
    | "time"
    | "description"
    | "location"
    | "color"
    | "reminderDate"
    | "reminderTime";
};

const flow = new Map<number, FlowState>();

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

function requireUser(ctx: any): number | null {
  const userId = ctx.from?.id;
  return typeof userId === "number" ? userId : null;
}

function isValidDateYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidTimeHHMM(s: string) {
  return /^\d{2}:\d{2}$/.test(s);
}
function isHexColor(s: string) {
  return /^#([0-9a-fA-F]{6})$/.test(s);
}

async function getTimezone(userId: number): Promise<string> {
  const UserSettings = (mongoose.models as any).UserSettings;
  if (!UserSettings) return "America/Chicago";
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

function parseZonedDateTime(dateYYYYMMDD: string, timeHHMM: string, tz: string): DateTime {
  const dt = DateTime.fromISO(`${dateYYYYMMDD}T${timeHHMM}`, { zone: tz });
  if (!dt.isValid) {
    throw new Error(dt.invalidExplanation || "Invalid date/time");
  }
  return dt;
}

function computeEventStart(d: EditDraft, tz: string): Date {
  const date = d.date!.trim();
  if (d.allDay) return parseZonedDateTime(date, "00:00", tz).toJSDate();
  return parseZonedDateTime(date, d.time!.trim(), tz).toJSDate();
}

function computeReminderRunAt(d: EditDraft, tz: string): Date | null {
  const mode = d.reminderMode || "none";
  if (mode === "none") return null;

  if (mode === "custom_time") {
    if (!d.reminderDate || !d.reminderTime) return null;
    return parseZonedDateTime(d.reminderDate.trim(), d.reminderTime.trim(), tz).toJSDate();
  }

  // at_event_time
  if (d.allDay) {
    if (!d.allDayReminderTime) return null;
    return parseZonedDateTime(d.date!.trim(), d.allDayReminderTime.trim(), tz).toJSDate();
  }

  return parseZonedDateTime(d.date!.trim(), d.time!.trim(), tz).toJSDate();
}

function isPast(dt: Date, tz: string): boolean {
  const now = DateTime.now().setZone(tz);
  const when = DateTime.fromJSDate(dt, { zone: tz });
  return when <= now;
}

function formatRunAt(dt: Date, tz: string): string {
  return DateTime.fromJSDate(dt, { zone: tz }).toFormat("MMM d, yyyy h:mm a");
}

function buildReminderText(d: EditDraft) {
  const title = d.title?.trim() || "Untitled Event";

  const when = (() => {
    const date = d.date?.trim() || "";
    if (!date) return "(no date set)";
    if (d.allDay) return `${date} (all day)`;
    const t = d.time?.trim() || "(no time set)";
    return `${date} ${t}`;
  })();

  const loc = d.location?.trim();
  const desc = d.description ?? "";

  return [
    `Event Reminder`,
    `Title: ${title}`,
    `When: ${when}`,
    loc ? `Location: ${loc}` : null,
    ``,
    `Description:`,
    desc, // FULL description
  ]
    .filter((x) => x !== null)
    .join("\n");
}

function summary(d: EditDraft) {
  const title = d.title?.trim() ? d.title.trim() : "(not set)";
  const date = d.date?.trim() ? d.date.trim() : "(not set)";
  const allDay = Boolean(d.allDay);
  const time = allDay ? "(all day)" : d.time?.trim() ? d.time.trim() : "(not set)";
  const desc = d.description?.trim() ? d.description.trim() : "(not set)";
  const loc = d.location?.trim() ? d.location.trim() : "(not set)";
  const color = d.color?.trim() ? d.color.trim() : "(not set)";

  const mode = d.reminderMode || "none";
  const remLine =
    mode === "none"
      ? "Reminder: none"
      : mode === "custom_time"
      ? `Reminder: custom (${d.reminderDate || "?"} ${d.reminderTime || "?"})`
      : d.allDay
      ? `Reminder: at event time (all-day @ ${d.allDayReminderTime || "?"})`
      : `Reminder: at event time`;

  return [
    `Title: ${title}`,
    `Date: ${date}`,
    `Time: ${time}`,
    `All day: ${allDay ? "Yes" : "No"}`,
    `Description: ${desc}`,
    `Location: ${loc}`,
    `Color: ${color}`,
    remLine,
  ].join("\n");
}

const PAGE_SIZE = 7;

const CB = {
  PAGE_PREV: "ev:edit:page:prev",
  PAGE_NEXT: "ev:edit:page:next",
  PICK_PREFIX: "ev:edit:pick:",

  SET_TITLE: "ev:edit:set:title",
  SET_DATE: "ev:edit:set:date",
  SET_TIME: "ev:edit:set:time",
  TOGGLE_ALLDAY: "ev:edit:toggle:allday",
  SET_DESC: "ev:edit:set:desc",
  SET_LOC: "ev:edit:set:loc",
  SET_COLOR: "ev:edit:set:color",
  CLEAR_DESC: "ev:edit:clear:desc",
  CLEAR_LOC: "ev:edit:clear:loc",
  CLEAR_COLOR: "ev:edit:clear:color",

  REMINDER_MENU: "ev:edit:rem:menu",
  REM_NONE: "ev:edit:rem:none",
  REM_AT_EVENT: "ev:edit:rem:at_event",
  REM_CUSTOM: "ev:edit:rem:custom",
  REM_CONFIRM_YES: "ev:edit:rem:confirm:yes",
  REM_CONFIRM_NO: "ev:edit:rem:confirm:no",

  SAVE: "ev:edit:save",
  SAVE_CONFIRM_YES: "ev:edit:save:yes",
  SAVE_CONFIRM_NO: "ev:edit:save:no",
  CANCEL: "ev:edit:cancel",
} as const;

function editMenuKeyboard(draft: EditDraft) {
  const allDayLabel = draft?.allDay ? "All day: ON" : "All day: OFF";

  const remLabel =
    !draft.reminderMode || draft.reminderMode === "none"
      ? "Reminder: None"
      : draft.reminderMode === "at_event_time"
      ? "Reminder: At event time"
      : "Reminder: Custom time";

  return Markup.inlineKeyboard([
    [Markup.button.callback("Set title", CB.SET_TITLE)],
    [Markup.button.callback("Set date (YYYY-MM-DD)", CB.SET_DATE)],
    [Markup.button.callback("Set time (HH:MM)", CB.SET_TIME)],
    [Markup.button.callback(allDayLabel, CB.TOGGLE_ALLDAY)],
    [
      Markup.button.callback("Set description", CB.SET_DESC),
      Markup.button.callback("Clear", CB.CLEAR_DESC),
    ],
    [
      Markup.button.callback("Set location", CB.SET_LOC),
      Markup.button.callback("Clear", CB.CLEAR_LOC),
    ],
    [
      Markup.button.callback("Set color", CB.SET_COLOR),
      Markup.button.callback("Clear", CB.CLEAR_COLOR),
    ],
    [Markup.button.callback(remLabel, CB.REMINDER_MENU)],
    [Markup.button.callback("Save changes", CB.SAVE)],
    [Markup.button.callback("Cancel", CB.CANCEL)],
  ]);
}

function reminderMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("None", CB.REM_NONE)],
    [Markup.button.callback("At event time", CB.REM_AT_EVENT)],
    [Markup.button.callback("Custom time", CB.REM_CUSTOM)],
    [Markup.button.callback("Back", CB.REM_CONFIRM_NO)],
  ]);
}

async function loadEventDoc(userId: number, eventId: string) {
  const EventModel = (mongoose.models as any).Event;
  if (!EventModel) throw new Error("Event model not registered");
  const doc = await EventModel.findOne({ _id: eventId, userId }).lean();
  if (!doc) throw new Error("Event not found");
  return doc;
}

async function listEvents(userId: number, limit: number, skip: number) {
  const EventModel = (mongoose.models as any).Event;
  if (!EventModel) throw new Error("Event model not registered");
  const docs = await EventModel.find({ userId })
    .sort({ startDate: 1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return docs as any[];
}

function eventButtonLabel(ev: any, tz: string) {
  const dt = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });
  const dateStr = dt.toFormat("MMM d");
  const timeStr = ev.allDay ? "All day" : dt.toFormat("h:mm a");
  const title = (ev.title || "Untitled").toString();
  const clipped = title.length > 24 ? title.slice(0, 24) + "…" : title;
  return `${dateStr} • ${timeStr} -- ${clipped}`;
}

async function showPicker(ctx: any, userId: number) {
  const st = flow.get(userId) || { step: "pick_event" as Step, draft: {}, page: 0 };
  const tz = await getTimezone(userId);

  const page = st.page ?? 0;
  const skip = page * PAGE_SIZE;

  const events = await listEvents(userId, PAGE_SIZE + 1, skip);
  const hasNext = events.length > PAGE_SIZE;
  const slice = events.slice(0, PAGE_SIZE);

  if (slice.length === 0) {
    flow.delete(userId);
    return ctx.reply("No events found.");
  }

  const rows: any[] = slice.map((ev) => [
    Markup.button.callback(eventButtonLabel(ev, tz), `${CB.PICK_PREFIX}${String(ev._id)}`),
  ]);

  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback("‹ Prev", CB.PAGE_PREV));
  if (hasNext) navRow.push(Markup.button.callback("Next ›", CB.PAGE_NEXT));
  if (navRow.length) rows.push(navRow);

  rows.push([Markup.button.callback("Cancel", CB.CANCEL)]);

  st.step = "pick_event";
  st.expect = undefined;
  st.page = page;
  flow.set(userId, st);

  return ctx.reply("Pick an event to edit:", Markup.inlineKeyboard(rows));
}

async function showEditMenu(ctx: any, userId: number, note?: string) {
  const st = flow.get(userId);
  if (!st?.eventId) return showPicker(ctx, userId);

  const text = `${note ? `${note}\n\n` : ""}Event edit:\n\n${summary(st.draft)}`;
  return ctx.reply(text, editMenuKeyboard(st.draft));
}

function draftFromEvent(ev: any, tz: string): EditDraft {
  const start = DateTime.fromJSDate(new Date(ev.startDate), { zone: tz });
  const date = start.toISODate() || undefined;
  const time = start.toFormat("HH:mm");

  return {
    title: ev.title ?? "",
    date,
    time,
    allDay: Boolean(ev.allDay),
    description: ev.description ?? "",
    location: ev.location ?? "",
    color: ev.color ?? "",
    reminderMode: ev.reminderId ? "at_event_time" : "none", // default guess; user can change
    reminderDate: undefined,
    reminderTime: undefined,
    allDayReminderTime: undefined,
  };
}

async function upsertLinkedReminder(
  userId: number,
  eventId: string,
  existingReminderId: any | undefined,
  draft: EditDraft,
  tz: string
) {
  const ReminderModel = (mongoose.models as any).Reminder;
  if (!ReminderModel) {
    // If reminders aren't registered, just unlink/skip
    if (existingReminderId) {
      // can’t delete; no model
      await updateEvent(userId, eventId, { reminderId: undefined } as any);
    }
    return;
  }

  const mode = draft.reminderMode || "none";

  // If none: delete existing, unlink
  if (mode === "none") {
    if (existingReminderId) {
      await ReminderModel.deleteOne({ _id: existingReminderId, userId });
    }
    await updateEvent(userId, eventId, { reminderId: undefined } as any);
    return;
  }

  // Need computable runAt
  const runAt = computeReminderRunAt(draft, tz);
  if (!runAt || isNaN(runAt.getTime())) {
    throw new Error("Reminder enabled but not fully configured");
  }
  if (isPast(runAt, tz)) {
    throw new Error("Reminder time is in the past");
  }

  const reminderText = buildReminderText(draft);

  if (existingReminderId) {
    await ReminderModel.updateOne(
      { _id: existingReminderId, userId },
      {
        $set: {
          text: reminderText,
          nextRunAt: runAt,
          status: "scheduled",
          schedule: { kind: "once" },
          timezone: tz,
        },
      }
    );
    return;
  }

  const reminderDoc = await ReminderModel.create({
    userId,
    chatId: userId,
    text: reminderText,
    status: "scheduled",
    nextRunAt: runAt,
    schedule: { kind: "once" },
    timezone: tz,
  });

  await updateEvent(userId, eventId, { reminderId: reminderDoc._id } as any);
}

export function register(bot: Telegraf) {
  bot.command("eventedit", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.set(userId, { step: "pick_event", page: 0, draft: {} });
    await showPicker(ctx, userId);
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB.PAGE_PREV, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();
    st.page = Math.max(0, (st.page ?? 0) - 1);
    flow.set(userId, st);
    await showPicker(ctx, userId);
  });

  bot.action(CB.PAGE_NEXT, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();
    st.page = (st.page ?? 0) + 1;
    flow.set(userId, st);
    await showPicker(ctx, userId);
  });

  bot.action(new RegExp(`^${CB.PICK_PREFIX}(.+)$`), async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB.PICK_PREFIX.length);
    await ctx.answerCbQuery();

    try {
      const tz = await getTimezone(userId);
      const ev = await loadEventDoc(userId, eventId);

      const st: FlowState = {
        step: "menu",
        eventId,
        draft: draftFromEvent(ev, tz),
      };
      flow.set(userId, st);

      await showEditMenu(ctx, userId, `Editing: ${ev.title || "Untitled Event"}`);
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load event: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.TOGGLE_ALLDAY, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    st.draft.allDay = !Boolean(st.draft.allDay);

    // If turning all-day ON, time is ignored but we keep it stored.
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await showEditMenu(ctx, userId, "Updated all-day.");
  });

  bot.action([CB.CLEAR_DESC, CB.CLEAR_LOC, CB.CLEAR_COLOR], async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    const data = getCbData(ctx);
    if (!data) return;

    await ctx.answerCbQuery();

    if (data === CB.CLEAR_DESC) st.draft.description = "";
    if (data === CB.CLEAR_LOC) st.draft.location = "";
    if (data === CB.CLEAR_COLOR) st.draft.color = "";

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await showEditMenu(ctx, userId, "Cleared.");
  });

  bot.action(
    [CB.SET_TITLE, CB.SET_DATE, CB.SET_TIME, CB.SET_DESC, CB.SET_LOC, CB.SET_COLOR],
    async (ctx) => {
      const userId = requireUser(ctx);
      if (!userId) return;
      const st = flow.get(userId);
      if (!st?.eventId) return;

      const data = getCbData(ctx);
      if (!data) return;

      await ctx.answerCbQuery();

      if (data === CB.SET_TITLE) {
        st.step = "title";
        st.expect = "title";
        flow.set(userId, st);
        return ctx.reply("Type the title:");
      }

      if (data === CB.SET_DATE) {
        st.step = "date";
        st.expect = "date";
        flow.set(userId, st);
        return ctx.reply("Type the date as YYYY-MM-DD:");
      }

      if (data === CB.SET_TIME) {
        if (st.draft.allDay) {
          st.step = "menu";
          st.expect = undefined;
          flow.set(userId, st);
          return showEditMenu(ctx, userId, "Time is ignored when All day is ON.");
        }

        st.step = "time";
        st.expect = "time";
        flow.set(userId, st);
        return ctx.reply("Type the time as HH:MM (24h):");
      }

      if (data === CB.SET_DESC) {
        st.step = "description";
        st.expect = "description";
        flow.set(userId, st);
        return ctx.reply("Type the description (send a single '-' to clear):");
      }

      if (data === CB.SET_LOC) {
        st.step = "location";
        st.expect = "location";
        flow.set(userId, st);
        return ctx.reply("Type the location (send a single '-' to clear):");
      }

      if (data === CB.SET_COLOR) {
        st.step = "color";
        st.expect = "color";
        flow.set(userId, st);
        return ctx.reply("Type a hex color like #5b8def (send a single '-' to clear):");
      }
    }
  );

  bot.action(CB.REMINDER_MENU, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();
    st.step = "reminder_pick";
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.reply("Reminder options:", reminderMenuKeyboard());
  });

  bot.action(CB.REM_NONE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    st.draft.reminderMode = "none";
    st.draft.reminderDate = undefined;
    st.draft.reminderTime = undefined;
    st.draft.allDayReminderTime = undefined;

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await showEditMenu(ctx, userId, "Reminder set to none (will delete linked reminder on save).");
  });

  bot.action(CB.REM_CUSTOM, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    st.draft.reminderMode = "custom_time";
    st.draft.allDayReminderTime = undefined;
    st.draft.reminderDate = undefined;
    st.draft.reminderTime = undefined;

    st.step = "reminder_date";
    st.expect = "reminderDate";
    flow.set(userId, st);

    return ctx.reply("Custom reminder: type the reminder date as YYYY-MM-DD:");
  });

  bot.action(CB.REM_AT_EVENT, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    st.draft.reminderMode = "at_event_time";
    st.draft.reminderDate = undefined;
    st.draft.reminderTime = undefined;

    // If all-day, we ALWAYS ask for reminder time.
    if (st.draft.allDay) {
      st.step = "reminder_time";
      st.expect = "reminderTime";
      flow.set(userId, st);
      return ctx.reply("All-day event: what time should the reminder fire? (HH:MM 24h)");
    }

    const tz = await getTimezone(userId);
    const runAt = computeReminderRunAt(st.draft, tz);

    if (!runAt || isNaN(runAt.getTime())) {
      st.step = "menu";
      st.expect = undefined;
      flow.set(userId, st);
      return showEditMenu(ctx, userId, "Set event date + time first (so I know when to remind you).");
    }
    if (isPast(runAt, tz)) {
      st.step = "menu";
      st.expect = undefined;
      flow.set(userId, st);
      return showEditMenu(ctx, userId, "That reminder time is in the past. Choose a future time.");
    }

    st.step = "reminder_confirm";
    st.expect = undefined;
    flow.set(userId, st);

    return ctx.reply(
      `Reminder will fire at:\n${formatRunAt(runAt, tz)}\n\nConfirm?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes", CB.REM_CONFIRM_YES)],
        [Markup.button.callback("No", CB.REM_CONFIRM_NO)],
      ])
    );
  });

  bot.action(CB.REM_CONFIRM_NO, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showEditMenu(ctx, userId, "Okay -- adjust reminder settings.");
  });

  bot.action(CB.REM_CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    const tz = await getTimezone(userId);
    const runAt = computeReminderRunAt(st.draft, tz);

    if (!runAt || isNaN(runAt.getTime())) {
      st.step = "menu";
      st.expect = undefined;
      flow.set(userId, st);
      return showEditMenu(ctx, userId, "Reminder time could not be computed.");
    }
    if (isPast(runAt, tz)) {
      st.step = "menu";
      st.expect = undefined;
      flow.set(userId, st);
      return showEditMenu(ctx, userId, "That reminder time is in the past. Choose a future time.");
    }

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showEditMenu(ctx, userId, `Reminder confirmed for ${formatRunAt(runAt, tz)}.`);
  });

  bot.action(CB.SAVE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    const d = st.draft;

    if (!d.title || !d.title.trim()) return showEditMenu(ctx, userId, "Missing title.");
    if (!d.date || !isValidDateYYYYMMDD(d.date.trim())) return showEditMenu(ctx, userId, "Missing/invalid date.");
    if (!d.allDay) {
      if (!d.time || !isValidTimeHHMM(d.time.trim())) {
        return showEditMenu(ctx, userId, "Missing/invalid time (or toggle All day ON).");
      }
    }

    // Reminder validation if enabled
    if (d.reminderMode && d.reminderMode !== "none") {
      const tz = await getTimezone(userId);
      const runAt = computeReminderRunAt(d, tz);
      if (!runAt || isNaN(runAt.getTime())) return showEditMenu(ctx, userId, "Reminder enabled but not configured.");
      if (isPast(runAt, tz)) return showEditMenu(ctx, userId, "Reminder time is in the past.");
    }

    st.step = "confirm_save";
    st.expect = undefined;
    flow.set(userId, st);

    return ctx.reply(
      "Save changes?\n\n" + summary(d),
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, save", CB.SAVE_CONFIRM_YES)],
        [Markup.button.callback("No, go back", CB.SAVE_CONFIRM_NO)],
      ])
    );
  });

  bot.action(CB.SAVE_CONFIRM_NO, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showEditMenu(ctx, userId, "Okay -- back to edit menu.");
  });

  bot.action(CB.SAVE_CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st?.eventId) return;

    await ctx.answerCbQuery();

    const eventId = st.eventId;
    const d = st.draft;

    try {
      const tz = await getTimezone(userId);

      // Load current event to know reminderId
      const existing = await loadEventDoc(userId, eventId);
      const existingReminderId = existing.reminderId;

      // Update event core fields
      const startDate = computeEventStart(d, tz);

      await updateEvent(userId, eventId, {
        title: d.title!.trim(),
        description: d.description ?? "",
        location: d.location?.trim() ? d.location.trim() : undefined,
        color: d.color?.trim() ? d.color.trim() : undefined,
        allDay: Boolean(d.allDay),
        startDate,
      } as any);

      // Upsert reminder based on draft.reminderMode
      await upsertLinkedReminder(userId, eventId, existingReminderId, d, tz);

      flow.delete(userId);
      await ctx.reply("Event updated.");
    } catch (e: any) {
      st.step = "menu";
      st.expect = undefined;
      flow.set(userId, st);
      await showEditMenu(ctx, userId, `Failed to save: ${e?.message ?? "Unknown error"}`);
    }
  });

bot.on("text", async (ctx, next) => {
  const txt = ctx.message?.text ?? "";
  if (txt.startsWith("/")) return next();

  const userId = requireUser(ctx);
  if (!userId) return;

  const st = flow.get(userId);
  if (!st || !st.expect) return next();

    if (st.expect === "title") st.draft.title = input;

    if (st.expect === "date") {
      if (!isValidDateYYYYMMDD(input)) return ctx.reply("Invalid date. Use YYYY-MM-DD.");
      st.draft.date = input;
    }

    if (st.expect === "time") {
      if (!isValidTimeHHMM(input)) return ctx.reply("Invalid time. Use HH:MM (24h).");
      st.draft.time = input;
    }

    if (st.expect === "description") st.draft.description = input === "-" ? "" : input;
    if (st.expect === "location") st.draft.location = input === "-" ? "" : input;

    if (st.expect === "color") {
      if (input === "-") st.draft.color = "";
      else {
        if (!isHexColor(input)) return ctx.reply("Invalid color. Use #RRGGBB or '-' to clear.");
        st.draft.color = input;
      }
    }

    if (st.expect === "reminderDate") {
      if (!isValidDateYYYYMMDD(input)) return ctx.reply("Invalid date. Use YYYY-MM-DD.");
      st.draft.reminderDate = input;

      st.step = "reminder_time";
      st.expect = "reminderTime";
      flow.set(userId, st);
      return ctx.reply("Now type the reminder time as HH:MM (24h):");
    }

    if (st.expect === "reminderTime") {
      if (!isValidTimeHHMM(input)) return ctx.reply("Invalid time. Use HH:MM (24h).");

      if (st.draft.reminderMode === "custom_time") {
        st.draft.reminderTime = input;
      } else if (st.draft.reminderMode === "at_event_time" && st.draft.allDay) {
        st.draft.allDayReminderTime = input;
      } else {
        st.draft.reminderTime = input;
      }

      const tz = await getTimezone(userId);
      const runAt = computeReminderRunAt(st.draft, tz);

      if (!runAt || isNaN(runAt.getTime())) {
        st.step = "menu";
        st.expect = undefined;
        flow.set(userId, st);
        return showEditMenu(ctx, userId, "Reminder time couldn’t be computed.");
      }
      if (isPast(runAt, tz)) {
        st.step = "menu";
        st.expect = undefined;
        flow.set(userId, st);
        return showEditMenu(ctx, userId, "That reminder time is in the past. Choose a future time.");
      }

      st.step = "reminder_confirm";
      st.expect = undefined;
      flow.set(userId, st);

      return ctx.reply(
        `Reminder will fire at:\n${formatRunAt(runAt, tz)}\n\nConfirm?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Yes", CB.REM_CONFIRM_YES)],
          [Markup.button.callback("No", CB.REM_CONFIRM_NO)],
        ])
      );
    }

    // After normal field edits, return to menu
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showEditMenu(ctx, userId, "Updated.");
  });
}