import { Telegraf, Markup } from "telegraf";
import { getEvent, listEvents, updateEvent } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";

/**
 * Telegraf typing fix:
 * CallbackQuery is a union; not all variants have "data" in TS.
 */
function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

/**
 * Local callback strings (kept short)
 */
const CB_PICK_EVENT_PREFIX = "ev:pick:";            // + <eventId>
const CB_EDIT_FIELD_PREFIX = "ev:edit:field:";      // + field
const CB_EDIT_ALLDAY_YES = "ev:edit:allday:yes";
const CB_EDIT_ALLDAY_NO = "ev:edit:allday:no";
const CB_EDIT_CONFIRM_SAVE = "ev:edit:confirm:save";
const CB_EDIT_CONFIRM_CANCEL = "ev:edit:confirm:cancel";

function isValidDateYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidTimeHHMM(s: string) {
  return /^\d{2}:\d{2}$/.test(s);
}

function prettyFieldName(field: string) {
  switch (field) {
    case "title": return "Title";
    case "date": return "Date";
    case "time": return "Time";
    case "allDay": return "All day";
    case "description": return "Description";
    case "location": return "Location";
    case "color": return "Color";
    default: return field;
  }
}

async function sendPickEventList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 20 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to edit. Use /eventadd to create one.");
    return;
  }

  // Send one message with multiple rows of buttons (2 per row)
  const rows: any[] = [];
  for (let i = 0; i < events.length; i += 2) {
    const a = events[i];
    const b = events[i + 1];

    const row = [
      Markup.button.callback(`${(a.title || "Untitled").slice(0, 20)}`, `${CB_PICK_EVENT_PREFIX}${a._id}`),
    ];

    if (b) {
      row.push(
        Markup.button.callback(`${(b.title || "Untitled").slice(0, 20)}`, `${CB_PICK_EVENT_PREFIX}${b._id}`)
      );
    }

    rows.push(row);
  }

  rows.push([Markup.button.callback("Cancel", CB_EDIT_CONFIRM_CANCEL)]);

  await ctx.reply("Which event do you want to edit?", Markup.inlineKeyboard(rows));
}

function fieldKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Title", `${CB_EDIT_FIELD_PREFIX}title`),
      Markup.button.callback("Date", `${CB_EDIT_FIELD_PREFIX}date`),
      Markup.button.callback("Time", `${CB_EDIT_FIELD_PREFIX}time`),
    ],
    [
      Markup.button.callback("All day", `${CB_EDIT_FIELD_PREFIX}allDay`),
      Markup.button.callback("Description", `${CB_EDIT_FIELD_PREFIX}description`),
    ],
    [
      Markup.button.callback("Location", `${CB_EDIT_FIELD_PREFIX}location`),
      Markup.button.callback("Color", `${CB_EDIT_FIELD_PREFIX}color`),
    ],
    [Markup.button.callback("Cancel", CB_EDIT_CONFIRM_CANCEL)],
  ]);
}

export function register(bot: Telegraf) {
  /**
   * Start edit flow
   */
  bot.command("eventedit", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    setState(userId, {
      kind: "event_edit",
      step: "pick_event",
      draft: { eventId: "" },
    });

    try {
      await sendPickEventList(ctx, userId);
    } catch (err: any) {
      await ctx.reply(`Failed to load events: ${err?.message ?? "Unknown error"}`);
      clearState(userId);
    }
  });

  /**
   * Pick event button
   */
  bot.action(new RegExp(`^${CB_PICK_EVENT_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "pick_event") return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB_PICK_EVENT_PREFIX.length);

    state.draft.eventId = eventId;
    state.step = "pick_field";
    setState(userId, state);

    await ctx.answerCbQuery();
    await ctx.reply("Edit: What do you want to change?", fieldKeyboard());
  });

  /**
   * Pick field button
   */
  bot.action(new RegExp(`^${CB_EDIT_FIELD_PREFIX}(title|date|time|allDay|description|location|color)$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "pick_field") return;

    const data = getCbData(ctx);
    if (!data) return;

    const field = data.slice(CB_EDIT_FIELD_PREFIX.length) as any;

    state.draft.field = field;
    state.step = "enter_value";
    setState(userId, state);

    await ctx.answerCbQuery();

    if (field === "allDay") {
      return ctx.reply(
        "All day?",
        Markup.inlineKeyboard([
          [Markup.button.callback("Yes", CB_EDIT_ALLDAY_YES), Markup.button.callback("No", CB_EDIT_ALLDAY_NO)],
          [Markup.button.callback("Cancel", CB_EDIT_CONFIRM_CANCEL)],
        ])
      );
    }

    if (field === "date") return ctx.reply("Enter the new date (YYYY-MM-DD):");
    if (field === "time") return ctx.reply("Enter the new time (HH:MM, 24h):");

    return ctx.reply(`Enter the new ${prettyFieldName(field)}:`);
  });

  /**
   * AllDay yes/no buttons
   */
  bot.action([CB_EDIT_ALLDAY_YES, CB_EDIT_ALLDAY_NO], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "enter_value") return;
    if (state.draft.field !== "allDay") return;

    const data = getCbData(ctx);
    if (!data) return;

    const val = data === CB_EDIT_ALLDAY_YES;

    state.draft.value = val;
    state.step = "confirm";
    setState(userId, state);

    await ctx.answerCbQuery();

    await ctx.reply(
      `Confirm change?\nEvent: ${state.draft.eventId}\nField: All day\nNew value: ${val ? "Yes" : "No"}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Save", CB_EDIT_CONFIRM_SAVE)],
        [Markup.button.callback("Cancel", CB_EDIT_CONFIRM_CANCEL)],
      ])
    );
  });

  /**
   * Text entry for fields that need typing
   */
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_edit") return;
    if (state.step !== "enter_value") return;

    const field = state.draft.field;
    if (!field) return;

    const text = ctx.message.text.trim();

    if (field === "date" && !isValidDateYYYYMMDD(text)) return ctx.reply("Please use YYYY-MM-DD.");
    if (field === "time" && !isValidTimeHHMM(text)) return ctx.reply("Please use HH:MM (24h).");

    state.draft.value = text;
    state.step = "confirm";
    setState(userId, state);

    await ctx.reply(
      `Confirm change?\nEvent: ${state.draft.eventId}\nField: ${prettyFieldName(field)}\nNew value: ${text}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Save", CB_EDIT_CONFIRM_SAVE)],
        [Markup.button.callback("Cancel", CB_EDIT_CONFIRM_CANCEL)],
      ])
    );
  });

  /**
   * Cancel
   */
  bot.action(CB_EDIT_CONFIRM_CANCEL, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  /**
   * Save
   */
  bot.action(CB_EDIT_CONFIRM_SAVE, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "confirm") return;

    const eventId = state.draft.eventId;
    const field = state.draft.field;
    const value = state.draft.value;

    if (!eventId || !field) return;

    await ctx.answerCbQuery();

    try {
      const updates: any = {};

      if (field === "allDay") {
        updates.allDay = Boolean(value);
      } else if (field === "title") {
        updates.title = String(value);
      } else if (field === "description") {
        updates.description = String(value);
      } else if (field === "location") {
        updates.location = String(value);
      } else if (field === "color") {
        updates.color = String(value);
      } else if (field === "date" || field === "time") {
        const existing = await getEvent(userId, eventId);
        const ex = new Date(existing.startDate);

        const yyyy = ex.getFullYear();
        const mm = String(ex.getMonth() + 1).padStart(2, "0");
        const dd = String(ex.getDate()).padStart(2, "0");
        const oldDate = `${yyyy}-${mm}-${dd}`;
        const oldTime = `${String(ex.getHours()).padStart(2, "0")}:${String(ex.getMinutes()).padStart(2, "0")}`;

        const newDate = field === "date" ? String(value) : oldDate;
        const newTime = field === "time" ? String(value) : oldTime;

        const next = new Date(`${newDate}T${newTime}:00`);
        if (Number.isNaN(next.getTime())) {
          return ctx.reply("That produced an invalid date/time. Canceled for safety.");
        }

        updates.startDate = next;
      }

      await updateEvent(userId, eventId, updates);

      clearState(userId);
      await ctx.reply("Event updated.");
    } catch (err: any) {
      await ctx.reply(`Failed to update event: ${err?.message ?? "Unknown error"}`);
    }
  });
}