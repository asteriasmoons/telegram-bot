import { Telegraf, Markup } from "telegraf";
import { DateTime } from "luxon";
import { Reminder } from "../models/Reminder";
import { Draft } from "../models/Draft";
import { UserSettings } from "../models/UserSettings";

const PAGE_SIZE = 5;
const ACTIVE_STATUSES = ["scheduled", "active"] as const;

type Awaiting = "message" | "date" | "time" | "interval";
type EditMode = "none" | "message" | "date" | "time" | "frequency";

function minutesFromNow(min: number) {
  return new Date(Date.now() + min * 60_000);
}

async function getTz(userId: number) {
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

function fmtLine(r: any, tz: string) {
  const when = r.nextRunAt
    ? DateTime.fromJSDate(r.nextRunAt, { zone: tz }).toFormat("LLL d HH:mm")
    : "(no time)";
  const text = String(r.text || "").trim().replace(/\s+/g, " ");
  const short = text.length > 40 ? text.slice(0, 40) + "…" : (text || "(no message)");
  return `${when} -- ${short}`;
}

function kbList(reminders: any[], page: number, tz: string) {
  const rows: any[] = reminders.map((r) => [
    Markup.button.callback(fmtLine(r, tz), `re:open:${String(r._id)}:${page}`)
  ]);

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("Prev", `re:list:${page - 1}`));
  nav.push(Markup.button.callback("Next", `re:list:${page + 1}`));
  rows.push(nav);

  rows.push([Markup.button.callback("Close", "re:close")]);
  return Markup.inlineKeyboard(rows);
}

function kbOpen(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Edit message", `re:edit:message:${id}:${page}`)],
    [Markup.button.callback("Edit date", `re:edit:date:${id}:${page}`), Markup.button.callback("Edit time", `re:edit:time:${id}:${page}`)],
    [Markup.button.callback("Edit frequency", `re:edit:frequency:${id}:${page}`)],
    [Markup.button.callback("Delete", `re:delete:${id}:${page}`)],
    [Markup.button.callback("Back", `re:list:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickDate(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Today", `re:set:date:${id}:${page}:today`), Markup.button.callback("Tomorrow", `re:set:date:${id}:${page}:tomorrow`)],
    [Markup.button.callback("Type a date (YYYY-MM-DD)", `re:set:date:${id}:${page}:custom`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickTime(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("09:00", `re:set:time:${id}:${page}:09:00`), Markup.button.callback("12:00", `re:set:time:${id}:${page}:12:00`)],
    [Markup.button.callback("18:00", `re:set:time:${id}:${page}:18:00`), Markup.button.callback("21:00", `re:set:time:${id}:${page}:21:00`)],
    [Markup.button.callback("Type a time (HH:MM)", `re:set:time:${id}:${page}:custom`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickFreq(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Once", `re:set:freq:${id}:${page}:once`)],
    [Markup.button.callback("Daily", `re:set:freq:${id}:${page}:daily`), Markup.button.callback("Weekly", `re:set:freq:${id}:${page}:weekly`)],
    [Markup.button.callback("Every X minutes", `re:set:freq:${id}:${page}:interval`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbConfirm(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Save", `re:save:${id}:${page}`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function formatDetails(rem: any, tz: string) {
  const when = rem.nextRunAt
    ? DateTime.fromJSDate(rem.nextRunAt, { zone: tz }).toFormat("ccc, LLL d yyyy 'at' HH:mm")
    : "(not set)";

  const sched = rem.schedule?.kind || "once";
  const lines: string[] = [];
  lines.push("Reminder");
  lines.push("");
  lines.push(`When: ${when}`);
  lines.push(`Frequency: ${sched}`);
  if (sched === "interval") lines.push(`Interval: ${String(rem.schedule.intervalMinutes)} minutes`);
  lines.push("");
  lines.push("Message:");
  lines.push(String(rem.text || ""));
  return lines.join("\n");
}

async function upsertEditDraft(params: {
  userId: number;
  chatId: number;
  tz: string;
  reminderId: string;
  page: number;
  awaiting?: Awaiting;
  editMode?: EditMode;
  stagedText?: string;
}) {
  const { userId, chatId, tz, reminderId, page, awaiting, editMode, stagedText } = params;

  await Draft.findOneAndUpdate(
    { userId, kind: "reminder_edit" },
    {
      $set: {
        userId,
        chatId,
        kind: "reminder_edit",
        step: "edit",
        timezone: tz,
        targetReminderId: reminderId,
        page,
        edit: {
          awaiting,
          editMode: editMode || "none",
          stagedText: stagedText || undefined
        },
        expiresAt: minutesFromNow(30)
      }
    },
    { upsert: true, new: true }
  );
}

async function getEditDraft(userId: number) {
  return Draft.findOne({ userId, kind: "reminder_edit" }).lean() as any;
}

async function clearEditDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "reminder_edit" });
}

function parseISODate(input: string) {
  const s = input.trim();
  const dt = DateTime.fromISO(s, { zone: "utc" });
  if (!dt.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function parseTimeHHMM(input: string) {
  const s = input.trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map((x) => Number(x));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return s;
}

function computeNextRunAt(tz: string, dateISO: string, timeHHMM: string) {
  const dt = DateTime.fromISO(`${dateISO}T${timeHHMM}`, { zone: tz });
  if (!dt.isValid) return null;
  return dt.toJSDate();
}

export function registerRemindersFlow(bot: Telegraf<any>) {
  bot.command("reminders", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const tz = await getTz(userId);
    await clearEditDraft(userId);

    const page = 0;
    const reminders = await Reminder.find({ userId, status: { $in: ACTIVE_STATUSES as any } })
      .sort({ nextRunAt: 1 })
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();

    if (reminders.length === 0) {
      await ctx.reply("You have no scheduled/active reminders right now.");
      return;
    }

    await ctx.reply("Your scheduled/active reminders (tap one):", kbList(reminders, page, tz));
  });

  bot.action(/^re:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const data = (ctx.callbackQuery as any)?.data as string;
    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});
    const tz = await getTz(userId);

    if (data === "re:close") {
      await clearEditDraft(userId);
      await ctx.reply("Closed.");
      return;
    }

    if (data.startsWith("re:list:")) {
      const page = Number(data.split(":")[2] || "0");
      const reminders = await Reminder.find({ userId, status: { $in: ACTIVE_STATUSES as any } })
        .sort({ nextRunAt: 1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean();

      if (reminders.length === 0) {
        await ctx.reply("No reminders on that page.");
        return;
      }

      await ctx.reply("Your scheduled/active reminders (tap one):", kbList(reminders, page, tz));
      return;
    }

    if (data.startsWith("re:open:")) {
      const [, , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      if (!rem) {
        await ctx.reply("That reminder is no longer scheduled/active.");
        return;
      }

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, editMode: "none" });
      await ctx.reply(formatDetails(rem, tz), kbOpen(id, page));
      return;
    }

    if (data.startsWith("re:edit:")) {
      const parts = data.split(":"); // re:edit:<field>:<id>:<page>
      const field = parts[2];
      const id = parts[3];
      const page = Number(parts[4] || "0");

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      if (!rem) {
        await ctx.reply("That reminder is no longer scheduled/active.");
        return;
      }

      if (field === "message") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "message", editMode: "message" });
        await ctx.reply("Type the new message (this replaces the old one).");
        return;
      }

      if (field === "date") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, editMode: "date" });
        await ctx.reply("Pick a date:", kbPickDate(id, page));
        return;
      }

      if (field === "time") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, editMode: "time" });
        await ctx.reply("Pick a time:", kbPickTime(id, page));
        return;
      }

      if (field === "frequency") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, editMode: "frequency" });
        await ctx.reply("Pick a frequency:", kbPickFreq(id, page));
        return;
      }
    }

    if (data.startsWith("re:set:date:")) {
      const parts = data.split(":"); // re:set:date:<id>:<page>:<today|tomorrow|custom>
      const id = parts[3];
      const page = Number(parts[4] || "0");
      const mode = parts[5];

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      if (!rem) {
        await ctx.reply("That reminder is no longer scheduled/active.");
        return;
      }

      if (mode === "custom") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "date", editMode: "date" });
        await ctx.reply("Type the date as YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const now = DateTime.now().setZone(tz);
      const dateISO = mode === "tomorrow"
        ? now.plus({ days: 1 }).toFormat("yyyy-LL-dd")
        : now.toFormat("yyyy-LL-dd");

      const cur = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const timeHHMM = cur.isValid ? cur.toFormat("HH:mm") : "09:00";
      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);

      if (!nextRunAt) {
        await ctx.reply("Could not compute that date/time. Try again.");
        return;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { nextRunAt } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Date updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    if (data.startsWith("re:set:time:")) {
      const parts = data.split(":"); // re:set:time:<id>:<page>:<HH:MM|custom>
      const id = parts[3];
      const page = Number(parts[4] || "0");
      const timeRaw = parts[5];

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      if (!rem) {
        await ctx.reply("That reminder is no longer scheduled/active.");
        return;
      }

      if (timeRaw === "custom") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "time", editMode: "time" });
        await ctx.reply("Type the time as HH:MM (24-hour). Example: 13:45");
        return;
      }

      const timeHHMM = parseTimeHHMM(timeRaw);
      if (!timeHHMM) {
        await ctx.reply("That time format is invalid.");
        return;
      }

      const cur = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const dateISO = cur.isValid ? cur.toFormat("yyyy-LL-dd") : DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");
      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);

      if (!nextRunAt) {
        await ctx.reply("Could not compute that date/time. Try again.");
        return;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { nextRunAt } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Time updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    if (data.startsWith("re:set:freq:")) {
      const parts = data.split(":"); // re:set:freq:<id>:<page>:<once|daily|weekly|interval>
      const id = parts[3];
      const page = Number(parts[4] || "0");
      const kind = parts[5];

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      if (!rem) {
        await ctx.reply("That reminder is no longer scheduled/active.");
        return;
      }

      if (kind === "interval") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "interval", editMode: "frequency" });
        await ctx.reply("Type the interval in minutes (example: 90).");
        return;
      }

      let schedule: any = undefined;
      if (kind === "daily") {
        const t = DateTime.fromJSDate(rem.nextRunAt, { zone: tz }).toFormat("HH:mm");
        schedule = { kind: "daily", timeOfDay: t };
      } else if (kind === "weekly") {
        const dt = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
        const t = dt.toFormat("HH:mm");
        const dow = dt.weekday % 7; // Sun=0..Sat=6
        schedule = { kind: "weekly", timeOfDay: t, daysOfWeek: [dow] };
      } else {
        schedule = undefined;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { schedule } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Frequency updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    if (data.startsWith("re:delete:")) {
      const parts = data.split(":"); // re:delete:<id>:<page>
      const id = parts[2];
      await Reminder.updateOne({ _id: id, userId }, { $set: { status: "deleted" } });
      await clearEditDraft(userId);
      await ctx.reply("Deleted. Use /reminders to see what’s left.");
      return;
    }

    if (data.startsWith("re:save:")) {
      const parts = data.split(":"); // re:save:<id>:<page>
      const id = parts[2];
      const page = Number(parts[3] || "0");

      const d = await getEditDraft(userId);
      if (!d || d.targetReminderId !== id) {
        await ctx.reply("No active edit session. Use /reminders again.");
        return;
      }

      const staged = d.edit?.stagedText;
      if (!staged || !String(staged).trim()) {
        await ctx.reply("Nothing to save. Use Edit message again.");
        return;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { text: staged } });
      await clearEditDraft(userId);

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Saved.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }
  });

  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!userId || !chatId || !text) return;

    const d = await getEditDraft(userId);
    if (!d) return;

    const tz = await getTz(userId);
    const reminderId = d.targetReminderId as string | undefined;
    const page = Number(d.page || 0);
    const awaiting: Awaiting | undefined = d.edit?.awaiting;

    if (!reminderId || !awaiting) return;

    const rem = await Reminder.findOne({ _id: reminderId, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
    if (!rem) {
      await clearEditDraft(userId);
      await ctx.reply("That reminder is no longer scheduled/active.");
      return;
    }

    if (awaiting === "message") {
      await upsertEditDraft({ userId, chatId, tz, reminderId, page, editMode: "message", stagedText: text, awaiting: undefined });
      await ctx.reply("Preview (message will be replaced with this):\n\n" + text, kbConfirm(reminderId, page));
      return;
    }

    if (awaiting === "date") {
      const dateISO = parseISODate(text);
      if (!dateISO) {
        await ctx.reply("Invalid date. Use YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const cur = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const timeHHMM = cur.isValid ? cur.toFormat("HH:mm") : "09:00";
      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!nextRunAt) {
        await ctx.reply("Could not compute that date/time.");
        return;
      }

      await Reminder.updateOne({ _id: reminderId, userId }, { $set: { nextRunAt } });
      await clearEditDraft(userId);

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Date updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    if (awaiting === "time") {
      const timeHHMM = parseTimeHHMM(text);
      if (!timeHHMM) {
        await ctx.reply("Invalid time. Use HH:MM (24-hour), like 13:45.");
        return;
      }

      const cur = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const dateISO = cur.isValid ? cur.toFormat("yyyy-LL-dd") : DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");
      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!nextRunAt) {
        await ctx.reply("Could not compute that date/time.");
        return;
      }

      await Reminder.updateOne({ _id: reminderId, userId }, { $set: { nextRunAt } });
      await clearEditDraft(userId);

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Time updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    if (awaiting === "interval") {
      const n = Number(text.trim());
      if (!Number.isFinite(n) || n <= 0) {
        await ctx.reply("Interval must be a positive number of minutes (example: 90).");
        return;
      }

      await Reminder.updateOne(
        { _id: reminderId, userId },
        { $set: { schedule: { kind: "interval", intervalMinutes: n } } }
      );

      await clearEditDraft(userId);

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: ACTIVE_STATUSES as any } }).lean();
      await ctx.reply("Frequency updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }
  });
}