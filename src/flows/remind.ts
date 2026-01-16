import { Markup, Telegraf } from "telegraf";
import { DateTime } from "luxon";
import { Draft } from "../models/Draft";
import { Reminder } from "../models/Reminder";
import { UserSettings } from "../models/UserSettings";
import { computeNextRunAt, humanizeWhen, nowInZone, parseISODate, parseTimeHHMM } from "../utils/time";

type RemindAction =
  | "rm:date:today"
  | "rm:date:tomorrow"
  | "rm:date:custom"
  | "rm:time:0900"
  | "rm:time:1200"
  | "rm:time:1800"
  | "rm:time:2100"
  | "rm:time:custom"
  | "rm:freq:once"
  | "rm:freq:daily"
  | "rm:freq:weekly"
  | "rm:freq:interval"
  | "rm:save"
  | "rm:cancel"
  | "rm:back:date"
  | "rm:back:time"
  | "rm:back:freq";

function expiresInMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

function dateButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Today", "rm:date:today"), Markup.button.callback("Tomorrow", "rm:date:tomorrow")],
    [Markup.button.callback("Pick a date (YYYY-MM-DD)", "rm:date:custom")],
    [Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function timeButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("09:00", "rm:time:0900"), Markup.button.callback("12:00", "rm:time:1200")],
    [Markup.button.callback("18:00", "rm:time:1800"), Markup.button.callback("21:00", "rm:time:2100")],
    [Markup.button.callback("Pick a time (HH:MM)", "rm:time:custom")],
    [Markup.button.callback("Back", "rm:back:date"), Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function freqButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Once", "rm:freq:once"), Markup.button.callback("Daily", "rm:freq:daily")],
    [Markup.button.callback("Weekly", "rm:freq:weekly"), Markup.button.callback("Every X minutes", "rm:freq:interval")],
    [Markup.button.callback("Back", "rm:back:time"), Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

function confirmButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Save reminder", "rm:save")],
    [Markup.button.callback("Back", "rm:back:freq"), Markup.button.callback("Cancel", "rm:cancel")]
  ]);
}

async function getUserTimezone(userId: number): Promise<string> {
  const settings = await UserSettings.findOne({ userId }).lean();
  return settings?.timezone || "America/Chicago";
}

async function getUserDmChatId(userId: number): Promise<number | null> {
  const settings = await UserSettings.findOne({ userId }).lean();
  return settings?.dmChatId ?? null;
}

async function upsertDraft(params: {
  userId: number;
  chatId: number;
  timezone: string;
  step: "choose_time" | "choose_repeat" | "enter_text" | "confirm";
  patch: any;
}) {
  const { userId, chatId, timezone, step, patch } = params;

  await Draft.findOneAndUpdate(
    { userId, kind: "reminder" },
    {
      $set: {
        userId,
        chatId,
        kind: "reminder",
        step,
        timezone,
        ...patch,
        expiresAt: expiresInMinutes(30)
      }
    },
    { upsert: true, new: true }
  );
}

async function loadDraft(userId: number) {
  return Draft.findOne({ userId, kind: "reminder" }).lean();
}

async function deleteDraft(userId: number) {
  await Draft.deleteOne({ userId, kind: "reminder" });
}

function formatPreview(draft: any): string {
  const r = draft?.reminder || {};
  const lines: string[] = [];
  lines.push("Reminder draft");
  lines.push("");
  lines.push(`Date: ${r.dateISO || "(not set)"}`);
  lines.push(`Time: ${r.timeHHMM || "(not set)"}`);
  lines.push(`Frequency: ${r.repeatKind || "(not set)"}`);
  if (r.repeatKind === "interval") lines.push(`Interval minutes: ${r.intervalMinutes ?? "(not set)"}`);
  lines.push(`Message: ${r.text || "(not set)"}`);

  if (r.dateISO && r.timeHHMM) {
    lines.push("");
    lines.push(`When: ${humanizeWhen({ timezone: draft.timezone, dateISO: r.dateISO, timeHHMM: r.timeHHMM })}`);
  }

  return lines.join("\n");
}

export function registerRemindFlow(bot: Telegraf<any>) {
  bot.command("remind", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) return;

    const timezone = await getUserTimezone(userId);
    const now = nowInZone(timezone);

    // Start a fresh draft at date step
    await Draft.findOneAndUpdate(
      { userId, kind: "reminder" },
      {
        $set: {
          userId,
          chatId,
          kind: "reminder",
          step: "choose_time",
          timezone,
          reminder: {
            dateISO: now.toFormat("yyyy-LL-dd")
          },
          expiresAt: expiresInMinutes(30)
        }
      },
      { upsert: true, new: true }
    );

    await ctx.reply(
      "Pick a date for the reminder.",
      dateButtons()
    );
  });

  bot.action(/^rm:/, async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const data = (ctx.callbackQuery as any)?.data as RemindAction | string;

    if (!userId || !chatId) return;

    await ctx.answerCbQuery().catch(() => {});

    const draft = await loadDraft(userId);
    if (!draft) {
      await ctx.reply("No active reminder draft. Use /remind to start.");
      return;
    }

    const timezone = draft.timezone || (await getUserTimezone(userId));
    const now = nowInZone(timezone);

    // DATE actions
    if (data === "rm:date:today") {
      const dateISO = now.toFormat("yyyy-LL-dd");
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_time",
        patch: { reminder: { ...(draft.reminder || {}), dateISO } }
      });
      await ctx.reply("Pick a time for the reminder.", timeButtons());
      return;
    }

    if (data === "rm:date:tomorrow") {
      const dateISO = now.plus({ days: 1 }).toFormat("yyyy-LL-dd");
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_time",
        patch: { reminder: { ...(draft.reminder || {}), dateISO } }
      });
      await ctx.reply("Pick a time for the reminder.", timeButtons());
      return;
    }

    if (data === "rm:date:custom") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_time",
        patch: { reminder: { ...(draft.reminder || {}), awaiting: "date" } }
      });
      await ctx.reply("Type the date as YYYY-MM-DD (example: 2026-01-16).");
      return;
    }

    // TIME actions
    if (data === "rm:time:0900" || data === "rm:time:1200" || data === "rm:time:1800" || data === "rm:time:2100") {
      const timeHHMM = data === "rm:time:0900" ? "09:00"
        : data === "rm:time:1200" ? "12:00"
        : data === "rm:time:1800" ? "18:00"
        : "21:00";

      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_repeat",
        patch: { reminder: { ...(draft.reminder || {}), timeHHMM, awaiting: undefined } }
      });

      await ctx.reply("Pick the frequency.", freqButtons());
      return;
    }

    if (data === "rm:time:custom") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_repeat",
        patch: { reminder: { ...(draft.reminder || {}), awaiting: "time" } }
      });
      await ctx.reply("Type the time as HH:MM (24-hour). Example: 09:30");
      return;
    }

    // FREQUENCY actions
    if (data === "rm:freq:once") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "enter_text",
        patch: { reminder: { ...(draft.reminder || {}), repeatKind: "none" } }
      });
      await ctx.reply("Type the reminder message.");
      return;
    }

    if (data === "rm:freq:daily") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "enter_text",
        patch: { reminder: { ...(draft.reminder || {}), repeatKind: "daily" } }
      });
      await ctx.reply("Type the reminder message.");
      return;
    }

    if (data === "rm:freq:weekly") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "enter_text",
        patch: { reminder: { ...(draft.reminder || {}), repeatKind: "weekly" } }
      });
      await ctx.reply("Type the reminder message.");
      return;
    }

    if (data === "rm:freq:interval") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "enter_text",
        patch: { reminder: { ...(draft.reminder || {}), repeatKind: "interval", awaiting: "interval" } }
      });
      await ctx.reply("Type the interval in minutes (example: 90).");
      return;
    }

    // BACK / CANCEL
    if (data === "rm:cancel") {
      await deleteDraft(userId);
      await ctx.reply("Canceled.");
      return;
    }

    if (data === "rm:back:date") {
      await ctx.reply("Pick a date for the reminder.", dateButtons());
      return;
    }

    if (data === "rm:back:time") {
      await ctx.reply("Pick a time for the reminder.", timeButtons());
      return;
    }

    if (data === "rm:back:freq") {
      await ctx.reply("Pick the frequency.", freqButtons());
      return;
    }

    // SAVE
    if (data === "rm:save") {
      const current = await loadDraft(userId);
      if (!current) {
        await ctx.reply("No active reminder draft. Use /remind to start.");
        return;
      }

      const r = current.reminder || {};
      if (!r.dateISO || !r.timeHHMM || !r.text) {
        await ctx.reply("Draft is incomplete. Please set date, time, and message.");
        return;
      }

      const dmChatId = await getUserDmChatId(userId);
      if (!dmChatId) {
        await ctx.reply("I can only DM reminders if you start a private chat with me first. Open my DM and send /start, then try again.");
        return;
      }

      const nextRunAt = computeNextRunAt({
        timezone: current.timezone,
        dateISO: r.dateISO,
        timeHHMM: r.timeHHMM
      });

      // If user picked a time already in the past for today, we still schedule it as chosen.
      // You can later add a guard to roll forward automatically if you want.
      const schedule =
        r.repeatKind === "daily"
          ? { kind: "daily" as const, timeOfDay: r.timeHHMM }
          : r.repeatKind === "weekly"
          ? {
              kind: "weekly" as const,
              timeOfDay: r.timeHHMM,
              daysOfWeek: [DateTime.fromISO(r.dateISO, { zone: current.timezone }).weekday % 7] // Sun=0..Sat=6
            }
          : r.repeatKind === "interval"
          ? { kind: "interval" as const, intervalMinutes: Number(r.intervalMinutes || 0) }
          : { kind: "once" as const };

      if (schedule.kind === "interval") {
        const n = schedule.intervalMinutes ?? 0;
        if (!Number.isFinite(n) || n <= 0) {
          await ctx.reply("Interval must be a positive number of minutes.");
          return;
        }
      }

      await Reminder.create({
        userId,
        chatId: dmChatId,
        text: r.text,
        status: "scheduled",
        nextRunAt,
        schedule: schedule.kind === "once" ? undefined : schedule,
        timezone: current.timezone,
        lastRunAt: undefined,
        lock: {}
      });

      await deleteDraft(userId);

      const preview = [
        "Saved reminder.",
        "",
        `When: ${humanizeWhen({ timezone: current.timezone, dateISO: r.dateISO, timeHHMM: r.timeHHMM })}`,
        `Frequency: ${r.repeatKind === "none" ? "once" : r.repeatKind}`,
        `Message: ${r.text}`
      ].join("\n");

      await ctx.reply(preview);
      return;
    }
  });

  // Capture typed inputs during draft steps
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;

    if (!userId || !chatId || !text) return;

    const draft = await loadDraft(userId);
    if (!draft || draft.kind !== "reminder") return;

    const timezone = draft.timezone || (await getUserTimezone(userId));
    const r = draft.reminder || {};
    const awaiting = (r as any).awaiting as string | undefined;

    // Custom date input
    if (awaiting === "date") {
      const parsed = parseISODate(text);
      if (!parsed.ok) {
        await ctx.reply(parsed.error);
        return;
      }

      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_time",
        patch: { reminder: { ...(r || {}), dateISO: parsed.iso, awaiting: undefined } }
      });

      await ctx.reply("Pick a time for the reminder.", timeButtons());
      return;
    }

    // Custom time input
    if (awaiting === "time") {
      const parsed = parseTimeHHMM(text);
      if (!parsed.ok) {
        await ctx.reply(parsed.error);
        return;
      }

      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "choose_repeat",
        patch: { reminder: { ...(r || {}), timeHHMM: parsed.hhmm, awaiting: undefined } }
      });

      await ctx.reply("Pick the frequency.", freqButtons());
      return;
    }

    // Interval minutes input
    if (awaiting === "interval") {
      const n = Number(text.trim());
      if (!Number.isFinite(n) || n <= 0) {
        await ctx.reply("Interval must be a positive number of minutes (example: 90).");
        return;
      }

      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "enter_text",
        patch: { reminder: { ...(r || {}), intervalMinutes: n, awaiting: "message" } }
      });

      await ctx.reply("Now type the reminder message.");
      return;
    }

    // Message input (if we are in enter_text step)
    if (draft.step === "enter_text") {
      await upsertDraft({
        userId,
        chatId,
        timezone,
        step: "confirm",
        patch: { reminder: { ...(r || {}), text, awaiting: undefined } }
      });

      const updated = await loadDraft(userId);
      await ctx.reply(formatPreview(updated), confirmButtons());
      return;
    }
  });
}