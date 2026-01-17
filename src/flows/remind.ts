import { Telegraf, Markup } from "telegraf";
import { DateTime } from "luxon";

import { Draft } from "../models/Draft";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";

type Awaiting = "message" | "date" | "time" | "interval";

function expiresIn(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

async function getSettings(userId: number) {
  return UserSettings.findOne({ userId }).lean();
}

async function getDraft(userId: number) {
  return Draft.findOne({ userId, kind: "reminder" }).lean() as any;
}

async function clearDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "reminder" });
}

async function upsertDraft(params: {
  userId: number;
  chatId: number;
  timezone: string;
  patch?: Record<string, any>;
  awaiting?: Awaiting;
}) {
  const { userId, chatId, timezone, patch, awaiting } = params;

  const current = await getDraft(userId);
  const curReminder = current?.reminder || {};

  await Draft.findOneAndUpdate(
    { userId, kind: "reminder" },
    {
      $set: {
        userId,
        chatId,
        kind: "reminder",
        step: "confirm",
        timezone,
        reminder: {
          ...curReminder,
          ...(patch || {}),
          awaiting: awaiting || undefined
        },
        expiresAt: expiresIn(30)
      }
    },
    { upsert: true, new: true }
  );
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

function normalizeRepeatKind(v: any) {
  if (v === "daily") return "daily";
  if (v === "weekly") return "weekly";
  if (v === "interval") return "interval";
  return "none";
}

function controlPanelText(d: any) {
  const msg = d?.reminder?.text ? String(d.reminder.text) : "(not set)";
  const dateISO = d?.reminder?.dateISO ? String(d.reminder.dateISO) : "(not set)";
  const timeHHMM = d?.reminder?.timeHHMM ? String(d.reminder.timeHHMM) : "(not set)";
  const repeat = normalizeRepeatKind(d?.reminder?.repeatKind);
  const interval = d?.reminder?.intervalMinutes ? String(d.reminder.intervalMinutes) : "";

  const lines: string[] = [];
  lines.push("New reminder");
  lines.push("");
  lines.push("Message:");
  lines.push(msg);
  lines.push("");
  lines.push(`Date: ${dateISO}`);
  lines.push(`Time: ${timeHHMM}`);
  lines.push(`Frequency: ${repeat}${repeat === "interval" && interval ? ` (${interval} minutes)` : ""}`);
  lines.push("");
  lines.push("Use the buttons below to set each part.");
  return lines.join("\n");
}

function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Set message", "rm:msg")],
    [Markup.button.callback("Set date", "rm:date"), Markup.button.callback("Set time", "rm:time")],
    [Markup.button.callback("Set frequency", "rm:freq")],
    [Markup.button.callback("Preview", "rm:preview"), Markup.button.callback("Save", "rm:save")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function kbPickDate() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Today", "rm:date:today"), Markup.button.callback("Tomorrow", "rm:date:tomorrow")],
    [Markup.button.callback("+3 days", "rm:date:plus3"), Markup.button.callback("+7 days", "rm:date:plus7")],
    [Markup.button.callback("Custom (type date)", "rm:date:custom")],
    [Markup.button.callback("Back", "rm:back")]
  ]);
}

function kbPickTime() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("09:00", "rm:time:09:00"), Markup.button.callback("12:00", "rm:time:12:00")],
    [Markup.button.callback("15:00", "rm:time:15:00"), Markup.button.callback("18:00", "rm:time:18:00")],
    [Markup.button.callback("21:00", "rm:time:21:00"), Markup.button.callback("23:00", "rm:time:23:00")],
    [Markup.button.callback("Custom (type time)", "rm:time:custom")],
    [Markup.button.callback("Back", "rm:back")]
  ]);
}

function kbPickFreq() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Once", "rm:freq:once")],
    [Markup.button.callback("Daily", "rm:freq:daily"), Markup.button.callback("Weekly", "rm:freq:weekly")],
    [Markup.button.callback("Interval (minutes)", "rm:freq:interval")],
    [Markup.button.callback("Back", "rm:back")]
  ]);
}

export function registerRemindFlow(bot: Telegraf<any>) {
  bot.command("remind", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const settings = await getSettings(userId);

    // You want reminders delivered to DM; require dmChatId
    if (!settings?.dmChatId) {
      await ctx.reply("Open a DM with this bot and run /start first. Reminders deliver to DM.");
      return;
    }

    const tz = settings.timezone || "America/Chicago";

    // fresh session
    await clearDraft(userId);
    await upsertDraft({
      userId,
      chatId: settings.dmChatId,
      timezone: tz,
      patch: { repeatKind: "none" }
    });

    const d = await getDraft(userId);
    await ctx.reply(controlPanelText(d), kbMain());
  });

  bot.action(/^rm:/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery().catch(() => {});

    const settings = await getSettings(userId);
    if (!settings?.dmChatId) {
      await clearDraft(userId);
      await ctx.reply("Open a DM with this bot and run /start first.");
      return;
    }

    const tz = settings.timezone || "America/Chicago";
    const data = (ctx.callbackQuery as any)?.data as string;

    const d = await getDraft(userId);
    if (!d) {
      await ctx.reply("No active /remind session. Run /remind again.");
      return;
    }

    if (data === "rm:cancel") {
      await clearDraft(userId);
      await ctx.reply("Cancelled.");
      return;
    }

    if (data === "rm:back") {
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (data === "rm:preview") {
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (data === "rm:msg") {
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "message" });
      await ctx.reply("Send the reminder message now (title + body is fine).");
      return;
    }

    if (data === "rm:date") {
      await ctx.reply("Pick a date:", kbPickDate());
      return;
    }

    if (data.startsWith("rm:date:")) {
      const mode = data.split(":")[2];

      if (mode === "custom") {
        await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "date" });
        await ctx.reply("Type the date as YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const now = DateTime.now().setZone(tz).startOf("day");
      let dateISO = now.toFormat("yyyy-LL-dd");

      if (mode === "tomorrow") dateISO = now.plus({ days: 1 }).toFormat("yyyy-LL-dd");
      if (mode === "plus3") dateISO = now.plus({ days: 3 }).toFormat("yyyy-LL-dd");
      if (mode === "plus7") dateISO = now.plus({ days: 7 }).toFormat("yyyy-LL-dd");

      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { dateISO } });

      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (data === "rm:time") {
      await ctx.reply("Pick a time:", kbPickTime());
      return;
    }

    if (data.startsWith("rm:time:")) {
      const t = data.split(":")[2];

      if (t === "custom") {
        await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "time" });
        await ctx.reply("Type the time as HH:MM (24-hour). Example: 13:45");
        return;
      }

      const timeHHMM = parseTimeHHMM(t);
      if (!timeHHMM) {
        await ctx.reply("Invalid time.");
        return;
      }

      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { timeHHMM } });

      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (data === "rm:freq") {
      await ctx.reply("Pick a frequency:", kbPickFreq());
      return;
    }

    if (data.startsWith("rm:freq:")) {
      const kind = data.split(":")[2]; // once|daily|weekly|interval

      if (kind === "interval") {
        await upsertDraft({
          userId,
          chatId: settings.dmChatId,
          timezone: tz,
          patch: { repeatKind: "interval" },
          awaiting: "interval"
        });
        await ctx.reply("Type the interval in minutes (example: 90).");
        return;
      }

      const repeatKind = kind === "daily" ? "daily" : kind === "weekly" ? "weekly" : "none";
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { repeatKind, intervalMinutes: undefined } });

      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (data === "rm:save") {
      const fresh = await getDraft(userId);

      const text = fresh?.reminder?.text ? String(fresh.reminder.text) : "";
      const dateISO = fresh?.reminder?.dateISO ? String(fresh.reminder.dateISO) : "";
      const timeHHMM = fresh?.reminder?.timeHHMM ? String(fresh.reminder.timeHHMM) : "";
      const repeatKind = normalizeRepeatKind(fresh?.reminder?.repeatKind);
      const intervalMinutes = Number(fresh?.reminder?.intervalMinutes);

      if (!text.trim()) {
        await ctx.reply("Message is not set yet. Tap "Set message".");
        return;
      }
      if (!dateISO || !timeHHMM) {
        await ctx.reply("Date/time not set yet. Tap "Set date" and "Set time".");
        return;
      }

      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);
      if (!nextRunAt) {
        await ctx.reply("Could not compute date/time. Please re-set date/time.");
        return;
      }

      let schedule: any = { kind: "once" as const };

      if (repeatKind === "daily") {
        schedule = { kind: "daily" as const, timeOfDay: timeHHMM };
      } else if (repeatKind === "weekly") {
        const dt = DateTime.fromISO(`${dateISO}T${timeHHMM}`, { zone: tz });
        const dow = dt.isValid ? (dt.weekday % 7) : (DateTime.now().setZone(tz).weekday % 7);
        schedule = { kind: "weekly" as const, timeOfDay: timeHHMM, daysOfWeek: [dow] };
      } else if (repeatKind === "interval") {
        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
          await ctx.reply("Interval minutes are not set/invalid. Tap "Set frequency" → Interval.");
          return;
        }
        schedule = { kind: "interval" as const, intervalMinutes };
      }

      await Reminder.create({
        userId,
        chatId: settings.dmChatId,
        text,
        status: "scheduled",
        nextRunAt,
        schedule,
        timezone: tz,
        lock: {}
      });

      await clearDraft(userId);
      await ctx.reply("Saved reminder.");
      return;
    }
  });

  // typed input ONLY happens after pressing a button that sets awaiting
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const d = await getDraft(userId);
    if (!d) return;

    const settings = await getSettings(userId);
    if (!settings?.dmChatId) {
      await clearDraft(userId);
      await ctx.reply("Open a DM with this bot and run /start first.");
      return;
    }

    const tz = settings.timezone || "America/Chicago";
    const awaiting: Awaiting | undefined = d.reminder?.awaiting;
    if (!awaiting) return;

    const text = ctx.message?.text || "";

    if (awaiting === "message") {
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { text }, awaiting: undefined });
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (awaiting === "date") {
      const dateISO = parseISODate(text);
      if (!dateISO) {
        await ctx.reply("Invalid date. Use YYYY-MM-DD (example: 2026-01-16).");
        return;
      }
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { dateISO }, awaiting: undefined });
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (awaiting === "time") {
      const timeHHMM = parseTimeHHMM(text);
      if (!timeHHMM) {
        await ctx.reply("Invalid time. Use HH:MM (24-hour), like 13:45.");
        return;
      }
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { timeHHMM }, awaiting: undefined });
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }

    if (awaiting === "interval") {
      const mins = Number(text.trim());
      if (!Number.isFinite(mins) || mins <= 0) {
        await ctx.reply("Interval must be a positive number of minutes (example: 90).");
        return;
      }
      await upsertDraft({ userId, chatId: settings.dmChatId, timezone: tz, patch: { intervalMinutes: mins }, awaiting: undefined });
      const fresh = await getDraft(userId);
      await ctx.reply(controlPanelText(fresh), kbMain());
      return;
    }
  });
}