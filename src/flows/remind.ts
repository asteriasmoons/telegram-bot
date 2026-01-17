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

function kbStart() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Set message", "rm:step:message")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function kbPickDate() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Today", "rm:date:today"), Markup.button.callback("Tomorrow", "rm:date:tomorrow")],
    [Markup.button.callback("Type a date (YYYY-MM-DD)", "rm:date:custom")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function kbPickTime() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("09:00", "rm:time:09:00"), Markup.button.callback("12:00", "rm:time:12:00")],
    [Markup.button.callback("18:00", "rm:time:18:00"), Markup.button.callback("21:00", "rm:time:21:00")],
    [Markup.button.callback("Type a time (HH:MM)", "rm:time:custom")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function kbPickFreq() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Once", "rm:freq:once")],
    [Markup.button.callback("Daily", "rm:freq:daily"), Markup.button.callback("Weekly", "rm:freq:weekly")],
    [Markup.button.callback("Every X minutes", "rm:freq:interval")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function kbConfirm() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Save reminder", "rm:save")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

async function getDraft(userId: number) {
  return Draft.findOne({ userId, kind: "reminder" }).lean() as any;
}

async function setDraft(params: {
  userId: number;
  chatId: number;
  timezone: string;
  awaiting?: Awaiting;
  patch?: Record<string, any>;
}) {
  const { userId, chatId, timezone, awaiting, patch } = params;

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
          ...(patch || {}),
          awaiting: awaiting || undefined
        },
        expiresAt: expiresIn(30)
      }
    },
    { upsert: true, new: true }
  );
}

async function clearDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "reminder" });
}

function previewText(d: any) {
  const msg = d?.reminder?.text ? String(d.reminder.text) : "(not set)";
  const dateISO = d?.reminder?.dateISO || "(not set)";
  const timeHHMM = d?.reminder?.timeHHMM || "(not set)";
  const freq = d?.reminder?.repeatKind || "once";
  const interval = d?.reminder?.intervalMinutes ? `${d.reminder.intervalMinutes}m` : "";

  const lines: string[] = [];
  lines.push("New reminder");
  lines.push("");
  lines.push("Message:");
  lines.push(msg);
  lines.push("");
  lines.push(`Date: ${dateISO}`);
  lines.push(`Time: ${timeHHMM}`);
  lines.push(`Frequency: ${freq}${interval ? ` (${interval})` : ""}`);
  return lines.join("\n");
}

export function registerRemindersFlow(bot: Telegraf<any>) {
  // IMPORTANT: This registers /remind (create flow)
  bot.command("remind", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const settings = await getSettings(userId);

    // Must have a DM chat id for delivery (your design)
    if (!settings?.dmChatId) {
      await ctx.reply("Open a DM with this bot and run /start first. Reminders deliver to DM.");
      return;
    }

    const tz = settings.timezone || "America/Chicago";
    await clearDraft(userId);

    // Create the draft and start by asking for message
    await setDraft({
      userId,
      chatId: settings.dmChatId,
      timezone: tz,
      awaiting: "message",
      patch: {}
    });

    await ctx.reply("Let’s create a reminder. Type the reminder message (you can include a title + body).");
  });

  bot.action(/^rm:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const data = (ctx.callbackQuery as any)?.data as string;
    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});

    if (data === "rm:cancel") {
      await clearDraft(userId);
      await ctx.reply("Cancelled.");
      return;
    }

    const settings = await getSettings(userId);
    if (!settings?.dmChatId) {
      await clearDraft(userId);
      await ctx.reply("Open a DM with this bot and run /start first.");
      return;
    }

    const tz = settings.timezone || "America/Chicago";
    const d = await getDraft(userId);

    if (!d) {
      await ctx.reply("No active /remind session. Run /remind again.");
      return;
    }

    if (data === "rm:step:message") {
      await setDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "message", patch: d.reminder || {} });
      await ctx.reply("Type the reminder message (you can include a title + body).");
      return;
    }

    if (data.startsWith("rm:date:")) {
      const mode = data.split(":")[2];

      if (mode === "custom") {
        await setDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "date", patch: d.reminder || {} });
        await ctx.reply("Type the date as YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      const now = DateTime.now().setZone(tz);
      const dateISO =
        mode === "tomorrow"
          ? now.plus({ days: 1 }).toFormat("yyyy-LL-dd")
          : now.toFormat("yyyy-LL-dd");

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), dateISO }
      });

      await ctx.reply("Pick a time:", kbPickTime());
      return;
    }

    if (data.startsWith("rm:time:")) {
      const t = data.split(":")[2];

      if (t === "custom") {
        await setDraft({ userId, chatId: settings.dmChatId, timezone: tz, awaiting: "time", patch: d.reminder || {} });
        await ctx.reply("Type the time as HH:MM (24-hour). Example: 13:45");
        return;
      }

      const timeHHMM = parseTimeHHMM(t);
      if (!timeHHMM) {
        await ctx.reply("Invalid time.");
        return;
      }

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), timeHHMM }
      });

      await ctx.reply("Pick a frequency:", kbPickFreq());
      return;
    }

    if (data.startsWith("rm:freq:")) {
      const kind = data.split(":")[2]; // once|daily|weekly|interval

      if (kind === "interval") {
        await setDraft({
          userId,
          chatId: settings.dmChatId,
          timezone: tz,
          awaiting: "interval",
          patch: { ...(d.reminder || {}), repeatKind: "interval" }
        });
        await ctx.reply("Type the interval in minutes (example: 90).");
        return;
      }

      const repeatKind = kind === "daily" ? "daily" : kind === "weekly" ? "weekly" : "none";

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), repeatKind }
      });

      const updated = await getDraft(userId);
      await ctx.reply(previewText(updated), kbConfirm());
      return;
    }

    if (data === "rm:save") {
      const fresh = await getDraft(userId);
      if (!fresh?.reminder?.text) {
        await ctx.reply("Missing message. Start again with /remind.");
        return;
      }
      if (!fresh?.reminder?.dateISO || !fresh?.reminder?.timeHHMM) {
        await ctx.reply("Missing date/time. Start again with /remind.");
        return;
      }

      const dateISO = String(fresh.reminder.dateISO);
      const timeHHMM = String(fresh.reminder.timeHHMM);
      const nextRunAt = computeNextRunAt(tz, dateISO, timeHHMM);

      if (!nextRunAt) {
        await ctx.reply("Could not compute the date/time. Start again with /remind.");
        return;
      }

      const repeatKind = fresh.reminder.repeatKind || "none";

      let schedule: any = { kind: "once" as const };

      if (repeatKind === "daily") {
        schedule = { kind: "daily" as const, timeOfDay: timeHHMM };
      } else if (repeatKind === "weekly") {
        const dt = DateTime.fromISO(`${dateISO}T${timeHHMM}`, { zone: tz });
        const dow = dt.isValid ? (dt.weekday % 7) : (DateTime.now().setZone(tz).weekday % 7);
        schedule = { kind: "weekly" as const, timeOfDay: timeHHMM, daysOfWeek: [dow] };
      } else if (repeatKind === "interval") {
        const mins = Number(fresh.reminder.intervalMinutes);
        if (!Number.isFinite(mins) || mins <= 0) {
          await ctx.reply("Interval minutes must be a positive number. Start again with /remind.");
          return;
        }
        schedule = { kind: "interval" as const, intervalMinutes: mins };
      } else {
        schedule = { kind: "once" as const };
      }

      await Reminder.create({
        userId,
        chatId: settings.dmChatId,
        text: String(fresh.reminder.text),
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

  // Text input handler for the create flow
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!userId || !chatId || !text) return;

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

    if (awaiting === "message") {
      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), text, awaiting: undefined }
      });
      await ctx.reply("Pick a date:", kbPickDate());
      return;
    }

    if (awaiting === "date") {
      const dateISO = parseISODate(text);
      if (!dateISO) {
        await ctx.reply("Invalid date. Use YYYY-MM-DD (example: 2026-01-16).");
        return;
      }

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), dateISO, awaiting: undefined }
      });

      await ctx.reply("Pick a time:", kbPickTime());
      return;
    }

    if (awaiting === "time") {
      const timeHHMM = parseTimeHHMM(text);
      if (!timeHHMM) {
        await ctx.reply("Invalid time. Use HH:MM (24-hour), like 13:45.");
        return;
      }

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), timeHHMM, awaiting: undefined }
      });

      await ctx.reply("Pick a frequency:", kbPickFreq());
      return;
    }

    if (awaiting === "interval") {
      const mins = Number(text.trim());
      if (!Number.isFinite(mins) || mins <= 0) {
        await ctx.reply("Interval must be a positive number of minutes (example: 90).");
        return;
      }

      await setDraft({
        userId,
        chatId: settings.dmChatId,
        timezone: tz,
        patch: { ...(d.reminder || {}), intervalMinutes: mins, awaiting: undefined }
      });

      const updated = await getDraft(userId);
      await ctx.reply(previewText(updated), kbConfirm());
      return;
    }
  });
}