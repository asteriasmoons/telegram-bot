import { Telegraf, Markup } from "telegraf";
import { DateTime } from "luxon";

import { Reminder } from "../models/Reminder";
import { Draft } from "../models/Draft";
import { UserSettings } from "../models/UserSettings";

const PAGE_SIZE = 5;
const LIST_STATUSES = ["scheduled"] as const;

type Awaiting = "message" | "date" | "time" | "interval";

function expiresIn(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

async function getTimezone(userId: number) {
  const s = await UserSettings.findOne({ userId }).lean();
  return s?.timezone || "America/Chicago";
}

/* ---------------- UI helpers ---------------- */

function fmtLine(rem: any, tz: string) {
  const when = rem.nextRunAt
    ? DateTime.fromJSDate(rem.nextRunAt, { zone: tz }).toFormat("LLL d HH:mm")
    : "(no time)";
  const text = String(rem.text || "").trim().replace(/\s+/g, " ");
  const short = text.length > 42 ? text.slice(0, 42) + "…" : (text || "(no message)");
  return `${when} -- ${short}`;
}

function kbList(reminders: any[], page: number, tz: string) {
  const rows: any[] = reminders.map((r) => [
    Markup.button.callback(fmtLine(r, tz), `re:open:${String(r._id)}:${page}`)
  ]);

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("Prev", `re:list:${page - 1}`));
  if (reminders.length === PAGE_SIZE) nav.push(Markup.button.callback("Next", `re:list:${page + 1}`));
  if (nav.length > 0) rows.push(nav);

  rows.push([Markup.button.callback("Close", "re:close")]);
  return Markup.inlineKeyboard(rows);
}

function kbOpen(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Edit message", `re:edit:message:${id}:${page}`)],
    [
      Markup.button.callback("Edit date", `re:edit:date:${id}:${page}`),
      Markup.button.callback("Edit time", `re:edit:time:${id}:${page}`)
    ],
    [Markup.button.callback("Edit frequency", `re:edit:frequency:${id}:${page}`)],
    [Markup.button.callback("Delete", `re:delete:${id}:${page}`)],
    [Markup.button.callback("Back", `re:list:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickDate(id: string, page: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Today", `re:set:date:${id}:${page}:today`),
      Markup.button.callback("Tomorrow", `re:set:date:${id}:${page}:tomorrow`)
    ],
    [Markup.button.callback("Type a date (YYYY-MM-DD)", `re:set:date:${id}:${page}:custom`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickTime(id: string, page: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("09:00", `re:set:time:${id}:${page}:09:00`),
      Markup.button.callback("12:00", `re:set:time:${id}:${page}:12:00`)
    ],
    [
      Markup.button.callback("18:00", `re:set:time:${id}:${page}:18:00`),
      Markup.button.callback("21:00", `re:set:time:${id}:${page}:21:00`)
    ],
    [Markup.button.callback("Type a time (HH:MM)", `re:set:time:${id}:${page}:custom`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function kbPickFreq(id: string, page: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Once", `re:set:freq:${id}:${page}:once`)],
    [
      Markup.button.callback("Daily", `re:set:freq:${id}:${page}:daily`),
      Markup.button.callback("Weekly", `re:set:freq:${id}:${page}:weekly`)
    ],
    [Markup.button.callback("Every X minutes", `re:set:freq:${id}:${page}:interval`)],
    [Markup.button.callback("Back", `re:open:${id}:${page}`), Markup.button.callback("Close", "re:close")]
  ]);
}

function formatDetails(rem: any, tz: string) {
  const when = rem.nextRunAt
    ? DateTime.fromJSDate(rem.nextRunAt, { zone: tz }).toFormat("ccc, LLL d yyyy 'at' HH:mm")
    : "(not set)";

  const kind = rem.schedule?.kind || "once";

  const lines: string[] = [];
  lines.push("Reminder");
  lines.push("");
  lines.push(`When: ${when}`);
  lines.push(`Frequency: ${kind}`);
  if (kind === "interval") lines.push(`Interval: ${String(rem.schedule?.intervalMinutes || "")} minutes`);
  lines.push("");
  lines.push("Message:");
  lines.push(String(rem.text || ""));
  return lines.join("\n");
}

function parseISODate(input: string) {
  const s = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const dt = DateTime.fromISO(s);
  return dt.isValid ? s : null;
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
  return dt.isValid ? dt.toJSDate() : null;
}

/* ---------------- Draft helpers (reminder_edit) ---------------- */

async function upsertEditDraft(params: {
  userId: number;
  chatId: number;
  tz: string;
  reminderId?: string;
  page?: number;
  awaiting?: Awaiting;
  stagedText?: string;
  stagedEntities?: any[];
  panelMessageId?: number;
}) {
  const {
    userId,
    chatId,
    tz,
    reminderId,
    page,
    awaiting,
    stagedText,
    stagedEntities,
    panelMessageId
  } = params;

  const update: any = {
    userId,
    chatId,
    kind: "reminder_edit",
    step: "edit",
    timezone: tz,

    targetReminderId: reminderId ?? undefined,
    page: page ?? undefined,

    edit: {
      awaiting: awaiting || undefined,
      stagedText: stagedText || undefined,
      stagedEntities: stagedEntities || undefined
    },

    expiresAt: expiresIn(30)
  };

  // ✅ ONLY overwrite panelMessageId if you passed one
  if (panelMessageId !== undefined) {
    update.panelMessageId = panelMessageId;
  }

  await Draft.findOneAndUpdate(
    { userId, kind: "reminder_edit" },
    { $set: update },
    { upsert: true, new: true }
  );
}

async function getEditDraft(userId: number) {
  return Draft.findOne({ userId, kind: "reminder_edit" }).lean() as any;
}

async function clearEditDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "reminder_edit" });
}

/**
 * Edit the ONE panel message. If it doesn't exist (or edit fails), send a new one and store panelMessageId.
 */
async function editPanel(ctx: any, userId: number, text: string, keyboard?: any) {
  const d = await getEditDraft(userId);

  // No draft yet -> send and create draft
  if (!d?.panelMessageId) {
    const sent = await ctx.reply(text, keyboard);
    await upsertEditDraft({
      userId,
      chatId: sent.chat.id,
      tz: d?.timezone || "America/Chicago",
      reminderId: d?.targetReminderId,
      page: d?.page,
      awaiting: d?.edit?.awaiting,
      stagedText: d?.edit?.stagedText,
      stagedEntities: d?.edit?.stagedEntities,
      panelMessageId: sent.message_id
    });
    return sent;
  }

  try {
    await ctx.telegram.editMessageText(d.chatId, d.panelMessageId, undefined, text, keyboard);
    return null;
  } catch {
    const sent = await ctx.reply(text, keyboard);
    await Draft.updateOne({ _id: d._id }, { $set: { panelMessageId: sent.message_id, chatId: sent.chat.id } });
    return sent;
  }
}

/* ---------------- Data fetch for list pages ---------------- */

async function fetchRemindersPage(userId: number, page: number) {
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

  return Reminder.find({
    userId,
    $or: [
      { status: "scheduled" },
      {
        status: "sent",
        schedule: { $exists: true, $ne: null },
        "schedule.kind": { $in: ["daily", "weekly", "interval"] },
        nextRunAt: { $lte: in24h }
      }
    ]
  })
    .sort({ nextRunAt: 1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();
}

/* ---------------- Main flow ---------------- */

export function registerRemindersListFlow(bot: Telegraf<any>) {
  bot.command("reminders", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const tz = await getTimezone(userId);
    await clearEditDraft(userId);

    const page = 0;
    const reminders = await fetchRemindersPage(userId, page);

    if (reminders.length === 0) {
      await ctx.reply("You have no scheduled reminders right now.");
      return;
    }

    const sent = await ctx.reply("Your scheduled reminders (tap one):", kbList(reminders, page, tz));

    // Store panelMessageId so we can edit THIS message going forward
    await upsertEditDraft({
      userId,
      chatId: sent.chat.id,
      tz,
      page,
      panelMessageId: sent.message_id
    });
  });

  bot.action(/^re:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const data = (ctx.callbackQuery as any)?.data as string;
    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});
    const tz = await getTimezone(userId);

    if (data === "re:close") {
      await clearEditDraft(userId);
      // Try to edit the panel to say Closed (so no extra message)
      await editPanel(ctx, userId, "Closed.");
      return;
    }

    /* ---------------- LIST (Prev/Next) ---------------- */

    if (data.startsWith("re:list:")) {
      const page = Number(data.split(":")[2] || "0");
      const reminders = await fetchRemindersPage(userId, page);

      if (reminders.length === 0) {
        await editPanel(ctx, userId, "No reminders on that page.");
        return;
      }

      await upsertEditDraft({ userId, chatId, tz, page });
      await editPanel(ctx, userId, "Your scheduled reminders (tap one):", kbList(reminders, page, tz));
      return;
    }

    /* ---------------- OPEN ---------------- */

    if (data.startsWith("re:open:")) {
      const [, , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      const rem = await Reminder.findOne({
        _id: id,
        userId,
        status: { $in: LIST_STATUSES as any }
      }).lean();

      if (!rem) {
        await editPanel(ctx, userId, "That reminder is no longer scheduled.");
        return;
      }

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page });
      await editPanel(ctx, userId, formatDetails(rem, tz), kbOpen(id, page));
      return;
    }

    /* ---------------- EDIT ENTRY POINTS ---------------- */

    if (data.startsWith("re:edit:message:")) {
      const [, , , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "message" });

      // Edit the panel to prompt for typed input
      await editPanel(ctx, userId, "Type the new message now (this replaces the old one).");
      return;
    }

    if (data.startsWith("re:edit:date:")) {
      const [, , , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page });
      await editPanel(ctx, userId, "Pick a date:", kbPickDate(id, page));
      return;
    }

    if (data.startsWith("re:edit:time:")) {
      const [, , , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page });
      await editPanel(ctx, userId, "Pick a time:", kbPickTime(id, page));
      return;
    }

    if (data.startsWith("re:edit:frequency:")) {
      const [, , , id, pageStr] = data.split(":");
      const page = Number(pageStr || "0");

      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page });
      await editPanel(ctx, userId, "Pick a frequency:", kbPickFreq(id, page));
      return;
    }

    /* ---------------- SET DATE ---------------- */

    if (data.startsWith("re:set:date:")) {
      const [, , , id, pageStr, mode] = data.split(":");
      const page = Number(pageStr || "0");

      if (mode === "custom") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "date" });
        await editPanel(ctx, userId, "Type the date as YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      if (!rem) {
        await editPanel(ctx, userId, "That reminder is no longer scheduled.");
        return;
      }

      const now = DateTime.now().setZone(tz);
      const dateISO =
        mode === "tomorrow"
          ? now.plus({ days: 1 }).toFormat("yyyy-LL-dd")
          : now.toFormat("yyyy-LL-dd");

      const current = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const timeHHMM = current.isValid ? current.toFormat("HH:mm") : "09:00";

      const next = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!next) {
        await editPanel(ctx, userId, "Could not compute that date/time. Try again.");
        return;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { nextRunAt: next } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: undefined });
      await editPanel(ctx, userId, "Date updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    /* ---------------- SET TIME ---------------- */

    if (data.startsWith("re:set:time:")) {
      const [, , , id, pageStr, timeRaw] = data.split(":");
      const page = Number(pageStr || "0");

      if (timeRaw === "custom") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "time" });
        await editPanel(ctx, userId, "Type the time as HH:MM (24-hour). Example: 13:45");
        return;
      }

      const timeHHMM = parseTimeHHMM(timeRaw);
      if (!timeHHMM) {
        await editPanel(ctx, userId, "Invalid time format.");
        return;
      }

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      if (!rem) {
        await editPanel(ctx, userId, "That reminder is no longer scheduled.");
        return;
      }

      const current = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const dateISO = current.isValid
        ? current.toFormat("yyyy-LL-dd")
        : DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");

      const next = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!next) {
        await editPanel(ctx, userId, "Could not compute that date/time. Try again.");
        return;
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { nextRunAt: next } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: undefined });
      await editPanel(ctx, userId, "Time updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    /* ---------------- SET FREQUENCY ---------------- */

    if (data.startsWith("re:set:freq:")) {
      const [, , , id, pageStr, kind] = data.split(":");
      const page = Number(pageStr || "0");

      if (kind === "interval") {
        await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: "interval" });
        await editPanel(ctx, userId, "Type the interval in minutes (example: 90).");
        return;
      }

      const rem = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      if (!rem) {
        await editPanel(ctx, userId, "That reminder is no longer scheduled.");
        return;
      }

      let schedule: any = { kind: "once" };
      const dt = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });

      if (kind === "daily") {
        schedule = { kind: "daily", timeOfDay: dt.toFormat("HH:mm") };
      } else if (kind === "weekly") {
        schedule = { kind: "weekly", timeOfDay: dt.toFormat("HH:mm"), daysOfWeek: [dt.weekday % 7] };
      } else {
        schedule = { kind: "once" };
      }

      await Reminder.updateOne({ _id: id, userId }, { $set: { schedule } });

      const updated = await Reminder.findOne({ _id: id, userId, status: { $in: LIST_STATUSES as any } }).lean();
      await upsertEditDraft({ userId, chatId, tz, reminderId: id, page, awaiting: undefined });
      await editPanel(ctx, userId, "Frequency updated.\n\n" + formatDetails(updated, tz), kbOpen(id, page));
      return;
    }

    /* ---------------- DELETE ---------------- */

    if (data.startsWith("re:delete:")) {
      const parts = data.split(":"); // re:delete:<id>:<page>
      const id = parts[2];

      await Reminder.updateOne({ _id: id, userId }, { $set: { status: "deleted" } });
      await clearEditDraft(userId);

      // Edit instead of sending new message
      await editPanel(ctx, userId, "Deleted.");
      return;
    }
  });

  /* ---------------- Typed input handler ---------------- */

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!userId || !chatId || !text) return next();

    // Let slash commands through
    if (text.startsWith("/")) return next();

    const d = await getEditDraft(userId);
    if (!d) return next();

    const tz = await getTimezone(userId);
    const reminderId = d.targetReminderId as string | undefined;
    const page = Number(d.page || 0);
    const awaiting: Awaiting | undefined = d.edit?.awaiting;

    if (!reminderId || !awaiting) return next();

    const rem = await Reminder.findOne({ _id: reminderId, userId, status: { $in: LIST_STATUSES as any } }).lean();
    if (!rem) {
      await clearEditDraft(userId);
      await editPanel(ctx, userId, "That reminder is no longer scheduled.");
      return;
    }

    if (awaiting === "message") {
      const rawEntities = (ctx.message as any)?.entities;
      const entities = Array.isArray(rawEntities) ? rawEntities : undefined;

      await Reminder.updateOne(
        { _id: reminderId, userId },
        { $set: { text, entities } }
      );

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: LIST_STATUSES as any } }).lean();

      await upsertEditDraft({ userId, chatId, tz, reminderId, page, awaiting: undefined });
      await editPanel(ctx, userId, "Message updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    if (awaiting === "date") {
      const dateISO = parseISODate(text);
      if (!dateISO) {
        await editPanel(ctx, userId, "Invalid date. Use YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const current = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const timeHHMM = current.isValid ? current.toFormat("HH:mm") : "09:00";

      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!nextRunAt) {
        await editPanel(ctx, userId, "Could not compute that date/time.");
        return;
      }

      await Reminder.updateOne({ _id: reminderId, userId }, { $set: { nextRunAt } });

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: LIST_STATUSES as any } }).lean();

      await upsertEditDraft({ userId, chatId, tz, reminderId, page, awaiting: undefined });
      await editPanel(ctx, userId, "Date updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    if (awaiting === "time") {
      const timeHHMM = parseTimeHHMM(text);
      if (!timeHHMM) {
        await editPanel(ctx, userId, "Invalid time. Use HH:MM (24-hour), like 13:45.");
        return;
      }

      const current = DateTime.fromJSDate(rem.nextRunAt, { zone: tz });
      const dateISO = current.isValid
        ? current.toFormat("yyyy-LL-dd")
        : DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");

      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!nextRunAt) {
        await editPanel(ctx, userId, "Could not compute that date/time.");
        return;
      }

      await Reminder.updateOne({ _id: reminderId, userId }, { $set: { nextRunAt } });

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: LIST_STATUSES as any } }).lean();

      await upsertEditDraft({ userId, chatId, tz, reminderId, page, awaiting: undefined });
      await editPanel(ctx, userId, "Time updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    if (awaiting === "interval") {
      const n = Number(text.trim());
      if (!Number.isFinite(n) || n <= 0) {
        await editPanel(ctx, userId, "Interval must be a positive number of minutes (example: 90).");
        return;
      }

      await Reminder.updateOne(
        { _id: reminderId, userId },
        { $set: { schedule: { kind: "interval", intervalMinutes: n } } }
      );

      const updated = await Reminder.findOne({ _id: reminderId, userId, status: { $in: LIST_STATUSES as any } }).lean();

      await upsertEditDraft({ userId, chatId, tz, reminderId, page, awaiting: undefined });
      await editPanel(ctx, userId, "Frequency updated.\n\n" + formatDetails(updated, tz), kbOpen(reminderId, page));
      return;
    }

    return next();
  });
}