import { Telegraf, Markup } from "telegraf";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import { createEvent, updateEvent } from "../services/events.service";

/**
 * Event Add (button-driven) + Optional linked Reminder
 * Luxon-based timezone handling (matches reminders style):
 * - Parse wall-clock date+time in user tz -> correct instant
 * - Display confirmations in user tz
 * - Validate "in the past" in user tz
 */

type Step =
  | "menu"
  | "title"
  | "date"
  | "time"
  | "description"
  | "location"
  | "color"
  | "reminder_pick"
  | "reminder_time"
  | "reminder_date"
  | "reminder_confirm"
  | "confirm";

type ReminderMode = "none" | "at_event_time" | "custom_time";

type EventDraft = {
  title?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM (24h)
  allDay?: boolean;
  description?: string;
  location?: string;
  color?: string; // #RRGGBB

  reminderMode?: ReminderMode;
  reminderDate?: string; // YYYY-MM-DD
  reminderTime?: string; // HH:MM
  allDayReminderTime?: string; // HH:MM
};

type FlowState = {
  step: Step;
  draft: EventDraft;
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

/**
 * Parse a wall-clock date + time in a specific timezone to a JS Date.
 * This is the ONLY correct way (no server-timezone involvement).
 */
function parseZonedDateTime(dateYYYYMMDD: string, timeHHMM: string, tz: string): DateTime {
  const dt = DateTime.fromISO(`${dateYYYYMMDD}T${timeHHMM}`, { zone: tz });
  if (!dt.isValid) {
    throw new Error(dt.invalidExplanation || "Invalid date/time");
  }
  return dt;
}

/**
 * Event start moment
 * - all-day: store at local 00:00 in tz
 * - timed: store at local HH:MM in tz
 */
function computeEventStart(d: EventDraft, tz: string): Date {
  const date = d.date!.trim();
  if (d.allDay) {
    return parseZonedDateTime(date, "00:00", tz).toJSDate();
  }
  return parseZonedDateTime(date, d.time!.trim(), tz).toJSDate();
}

/**
 * Reminder runAt moment
 */
function computeReminderRunAt(d: EventDraft, tz: string): Date | null {
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

/**
 * Compare "past/future" in the user's timezone.
 * We treat "now" as user-local now.
 */
function isPast(dt: Date, tz: string): boolean {
  const now = DateTime.now().setZone(tz);
  const when = DateTime.fromJSDate(dt, { zone: tz });
  return when <= now;
}

/**
 * Display in user tz (consistent, stable)
 */
function formatRunAt(dt: Date, tz: string): string {
  return DateTime.fromJSDate(dt, { zone: tz }).toFormat("MMM d, yyyy h:mm a");
}

function buildReminderText(d: EventDraft) {
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
    desc, // preserve line breaks
  ]
    .filter((x) => x !== null)
    .join("\n");
}

const CB = {
  SET_TITLE: "ev:add:set:title",
  SET_DATE: "ev:add:set:date",
  SET_TIME: "ev:add:set:time",
  TOGGLE_ALLDAY: "ev:add:toggle:allday",
  SET_DESC: "ev:add:set:desc",
  SET_LOC: "ev:add:set:loc",
  SET_COLOR: "ev:add:set:color",
  CLEAR_DESC: "ev:add:clear:desc",
  CLEAR_LOC: "ev:add:clear:loc",
  CLEAR_COLOR: "ev:add:clear:color",

  REMINDER_MENU: "ev:add:rem:menu",
  REM_NONE: "ev:add:rem:none",
  REM_AT_EVENT: "ev:add:rem:at_event",
  REM_CUSTOM: "ev:add:rem:custom",
  REM_CONFIRM_YES: "ev:add:rem:confirm:yes",
  REM_CONFIRM_NO: "ev:add:rem:confirm:no",

  CREATE: "ev:add:create",
  CONFIRM_YES: "ev:add:confirm:yes",
  CONFIRM_NO: "ev:add:confirm:no",
  CANCEL: "ev:add:cancel",
} as const;

function summary(d: EventDraft) {
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

function menuKeyboard(draft: EventDraft) {
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
    [Markup.button.callback("Create", CB.CREATE)],
    [Markup.button.callback("Cancel", CB.CANCEL)],
  ]);
}

async function showMenu(ctx: any, userId: number, note?: string) {
  const st = flow.get(userId);
  const draft = st?.draft ?? {};
  const text = `${note ? `${note}\n\n` : ""}Event add:\n\n${summary(draft)}`;
  await ctx.reply(text, menuKeyboard(draft));
}

function reminderMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("None", CB.REM_NONE)],
    [Markup.button.callback("At event time", CB.REM_AT_EVENT)],
    [Markup.button.callback("Custom time", CB.REM_CUSTOM)],
    [Markup.button.callback("Back", CB.REM_CONFIRM_NO)],
  ]);
}

export function register(bot: Telegraf) {
  bot.command("eventadd", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.set(userId, {
      step: "menu",
      draft: { allDay: false, reminderMode: "none" },
    });

    await showMenu(ctx, userId);
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB.TOGGLE_ALLDAY, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    st.draft.allDay = !Boolean(st.draft.allDay);

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();
    await showMenu(ctx, userId, "Updated all-day.");
  });

  bot.action([CB.CLEAR_DESC, CB.CLEAR_LOC, CB.CLEAR_COLOR], async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    const data = getCbData(ctx);
    if (!data) return;

    if (data === CB.CLEAR_DESC) st.draft.description = "";
    if (data === CB.CLEAR_LOC) st.draft.location = "";
    if (data === CB.CLEAR_COLOR) st.draft.color = "";

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();
    await showMenu(ctx, userId, "Cleared.");
  });

  bot.action(
    [CB.SET_TITLE, CB.SET_DATE, CB.SET_TIME, CB.SET_DESC, CB.SET_LOC, CB.SET_COLOR],
    async (ctx) => {
      const userId = requireUser(ctx);
      if (!userId) return;
      const st = flow.get(userId);
      if (!st) return;

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
          return showMenu(ctx, userId, "Time is ignored when All day is ON.");
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
    if (!st) return;

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
    if (!st) return;

    await ctx.answerCbQuery();

    st.draft.reminderMode = "none";
    st.draft.reminderDate = undefined;
    st.draft.reminderTime = undefined;
    st.draft.allDayReminderTime = undefined;

    st.step = "menu";
    flow.set(userId, st);

    await showMenu(ctx, userId, "Reminder set to none.");
  });

  bot.action(CB.REM_AT_EVENT, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();

    st.draft.reminderMode = "at_event_time";
    st.draft.reminderDate = undefined;
    st.draft.reminderTime = undefined;

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
      return showMenu(ctx, userId, "Set event date + time first (so I know when to remind you).");
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

  bot.action(CB.REM_CUSTOM, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

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

  bot.action(CB.REM_CONFIRM_NO, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showMenu(ctx, userId, "Okay -- adjust your settings.");
  });

  bot.action(CB.REM_CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();

    const tz = await getTimezone(userId);
    const runAt = computeReminderRunAt(st.draft, tz);
    if (!runAt || isNaN(runAt.getTime())) {
      st.step = "menu";
      flow.set(userId, st);
      return showMenu(ctx, userId, "Reminder time could not be computed. Check your inputs.");
    }
    if (isPast(runAt, tz)) {
      st.step = "menu";
      flow.set(userId, st);
      return showMenu(ctx, userId, "That reminder time is in the past. Choose a future time.");
    }

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showMenu(ctx, userId, `Reminder confirmed for ${formatRunAt(runAt, tz)}.`);
  });

  bot.action(CB.CREATE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    await ctx.answerCbQuery();

    const d = st.draft;

    if (!d.title || !d.title.trim()) return showMenu(ctx, userId, "Missing title.");
    if (!d.date || !isValidDateYYYYMMDD(d.date.trim())) return showMenu(ctx, userId, "Missing/invalid date.");

    if (!d.allDay) {
      if (!d.time || !isValidTimeHHMM(d.time.trim())) {
        return showMenu(ctx, userId, "Missing/invalid time (or toggle All day ON).");
      }
    }

    if (d.reminderMode && d.reminderMode !== "none") {
      const tz = await getTimezone(userId);
      const runAt = computeReminderRunAt(d, tz);
      if (!runAt || isNaN(runAt.getTime())) {
        return showMenu(ctx, userId, "Reminder is enabled but not fully configured yet.");
      }
      if (isPast(runAt, tz)) {
        return showMenu(ctx, userId, "Reminder time is in the past. Choose a future time.");
      }
    }

    // Also validate event start isn't in the past if you want (optional).
    // Not enforcing here unless you want it later.

    st.step = "confirm";
    st.expect = undefined;
    flow.set(userId, st);

    return ctx.reply(
      "Confirm create?\n\n" + summary(d),
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, create", CB.CONFIRM_YES)],
        [Markup.button.callback("No, go back", CB.CONFIRM_NO)],
      ])
    );
  });

  bot.action(CB.CONFIRM_NO, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st) return;

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();
    await showMenu(ctx, userId, "Okay -- back to options.");
  });

  bot.action(CB.CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;
    const st = flow.get(userId);
    if (!st || st.step !== "confirm") return;

    await ctx.answerCbQuery();

    const d = st.draft;

    try {
      const tz = await getTimezone(userId);

      const startDate = computeEventStart(d, tz);

      const eventDoc = await createEvent(userId, {
        title: d.title!.trim(),
        description: d.description ?? "",
        location: d.location?.trim() ? d.location.trim() : undefined,
        color: d.color?.trim() ? d.color.trim() : undefined,
        allDay: Boolean(d.allDay),
        startDate,
      });

      if (d.reminderMode && d.reminderMode !== "none") {
        const runAt = computeReminderRunAt(d, tz);
        if (runAt && !isNaN(runAt.getTime())) {
          if (isPast(runAt, tz)) {
            flow.delete(userId);
            return ctx.reply(`Event created.\nID: ${eventDoc._id}\n(Reminder not linked: time was in the past.)`);
          }

          const Reminder = (mongoose.models as any).Reminder;
          if (!Reminder) {
            flow.delete(userId);
            return ctx.reply(
              `Event created (no reminder linked -- Reminder model not registered).\nID: ${eventDoc._id}`
            );
          }

          const reminderText = buildReminderText(d);

          const reminderDoc = await Reminder.create({
            userId,
            chatId: userId,
            text: reminderText,
            status: "scheduled",
            nextRunAt: runAt,
            schedule: { kind: "once" },
            timezone: tz,
          });

          const linkUpdate: any = { reminderId: reminderDoc._id };
          // Optional fields for later edit behavior:
          linkUpdate.reminderMode = d.reminderMode;
          if (d.reminderMode === "custom_time") linkUpdate.customReminderAt = runAt;

          try {
            await updateEvent(userId, String(eventDoc._id), linkUpdate);
          } catch {
            // If your schema/service doesn't accept these fields yet, we’ll add in event-edit step.
          }
        }
      }

      flow.delete(userId);
      await ctx.reply(`Event created.\nID: ${eventDoc._id}`);
    } catch (e: any) {
      st.step = "menu";
      flow.set(userId, st);
      await showMenu(ctx, userId, `Failed to create: ${e?.message ?? "Unknown error"}`);
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
        return showMenu(ctx, userId, "Reminder time couldn’t be computed. Check settings.");
      }
      if (isPast(runAt, tz)) {
        st.step = "menu";
        st.expect = undefined;
        flow.set(userId, st);
        return showMenu(ctx, userId, "That reminder time is in the past. Choose a future time.");
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

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showMenu(ctx, userId, "Updated.");
  });
}