import { Telegraf, Markup } from "telegraf";
import { createEvent } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";
import { CB } from "./_event.callbacks";

function isValidDateYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidTimeHHMM(s: string) {
  return /^\d{2}:\d{2}$/.test(s);
}

function buildAddSummary(draft: any) {
  const when = draft.allDay
    ? `${draft.date} (all day)`
    : `${draft.date} ${draft.time || ""}`.trim();

  return [
    `Title: ${draft.title || "-"}`,
    `When: ${when || "-"}`,
    `Description: ${draft.description || "-"}`,
    `Location: ${draft.location || "-"}`,
    `Color: ${draft.color || "-"}`,
  ].join("\n");
}

export function register(bot: Telegraf) {
  // Start flow
  bot.command("eventadd", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    setState(userId, { kind: "event_add", step: "title", draft: {} });
    await ctx.reply("Event add: What is the title?");
  });

  // Button handlers for add flow
  bot.action([CB.ADD_ALLDAY_YES, CB.ADD_ALLDAY_NO], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_add" || state.step !== "allDay") return;

    state.draft.allDay = ctx.callbackQuery.data === CB.ADD_ALLDAY_YES;
    state.step = state.draft.allDay ? "description" : "time";
    setState(userId, state);

    await ctx.answerCbQuery();

    if (state.draft.allDay) {
      await ctx.reply(
        "Optional: add a description? (or tap Skip)",
        Markup.inlineKeyboard([
          Markup.button.callback("Skip", CB.ADD_SKIP_DESC),
        ])
      );
    } else {
      await ctx.reply("What time? (HH:MM, 24h)");
    }
  });

  bot.action(CB.ADD_SKIP_DESC, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_add" || state.step !== "description") return;

    state.draft.description = "";
    state.step = "location";
    setState(userId, state);

    await ctx.answerCbQuery();
    await ctx.reply(
      "Optional: add a location? (or tap Skip)",
      Markup.inlineKeyboard([Markup.button.callback("Skip", CB.ADD_SKIP_LOC)])
    );
  });

  bot.action(CB.ADD_SKIP_LOC, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_add" || state.step !== "location") return;

    state.draft.location = "";
    state.step = "color";
    setState(userId, state);

    await ctx.answerCbQuery();
    await ctx.reply(
      "Optional: pick a color hex like #5b8def, or tap Skip",
      Markup.inlineKeyboard([Markup.button.callback("Skip", CB.ADD_SKIP_COLOR)])
    );
  });

  bot.action(CB.ADD_SKIP_COLOR, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_add" || state.step !== "color") return;

    state.draft.color = "";
    state.step = "confirm";
    setState(userId, state);

    await ctx.answerCbQuery();
    await ctx.reply(
      "Confirm create?\n\n" + buildAddSummary(state.draft),
      Markup.inlineKeyboard([
        [Markup.button.callback("Create", CB.ADD_CONFIRM_CREATE)],
        [Markup.button.callback("Cancel", CB.ADD_CONFIRM_CANCEL)],
      ])
    );
  });

  bot.action(CB.ADD_CONFIRM_CANCEL, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB.ADD_CONFIRM_CREATE, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state || state.kind !== "event_add" || state.step !== "confirm") return;

    const d = state.draft;

    // Build startDate
    const startDate = d.allDay
      ? new Date(`${d.date}T00:00:00`)
      : new Date(`${d.date}T${d.time}:00`);

    await ctx.answerCbQuery();

    try {
      const doc = await createEvent(userId, {
        title: d.title!,
        description: d.description || undefined,
        location: d.location || undefined,
        color: d.color || undefined,
        allDay: Boolean(d.allDay),
        startDate,
      });

      clearState(userId);
      await ctx.reply(`Event created.\nID: ${doc._id}\n\n${buildAddSummary(d)}`);
    } catch (e: any) {
      await ctx.reply(`Failed to create event: ${e.message ?? "Unknown error"}`);
    }
  });

  // Text prompts handler (single handler for the flow)
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = getState(userId);
    if (!state) return;

    // Only consume text if we are in event_add flow
    if (state.kind !== "event_add") return;

    const text = ctx.message.text.trim();

    if (state.step === "title") {
      state.draft.title = text;
      state.step = "date";
      setState(userId, state);
      return ctx.reply("Date? (YYYY-MM-DD)");
    }

    if (state.step === "date") {
      if (!isValidDateYYYYMMDD(text)) return ctx.reply("Please use YYYY-MM-DD.");
      state.draft.date = text;
      state.step = "allDay";
      setState(userId, state);
      return ctx.reply(
        "All day?",
        Markup.inlineKeyboard([
          [Markup.button.callback("Yes", CB.ADD_ALLDAY_YES), Markup.button.callback("No", CB.ADD_ALLDAY_NO)],
        ])
      );
    }

    if (state.step === "time") {
      if (!isValidTimeHHMM(text)) return ctx.reply("Please use HH:MM (24h).");
      state.draft.time = text;
      state.step = "description";
      setState(userId, state);
      return ctx.reply(
        "Optional: add a description? (or tap Skip)",
        Markup.inlineKeyboard([Markup.button.callback("Skip", CB.ADD_SKIP_DESC)])
      );
    }

    if (state.step === "description") {
      state.draft.description = text;
      state.step = "location";
      setState(userId, state);
      return ctx.reply(
        "Optional: add a location? (or tap Skip)",
        Markup.inlineKeyboard([Markup.button.callback("Skip", CB.ADD_SKIP_LOC)])
      );
    }

    if (state.step === "location") {
      state.draft.location = text;
      state.step = "color";
      setState(userId, state);
      return ctx.reply(
        "Optional: pick a color hex like #5b8def, or tap Skip",
        Markup.inlineKeyboard([Markup.button.callback("Skip", CB.ADD_SKIP_COLOR)])
      );
    }

    if (state.step === "color") {
      // accept raw, service will validate hex if you kept that validation
      state.draft.color = text;
      state.step = "confirm";
      setState(userId, state);
      return ctx.reply(
        "Confirm create?\n\n" + buildAddSummary(state.draft),
        Markup.inlineKeyboard([
          [Markup.button.callback("Create", CB.ADD_CONFIRM_CREATE)],
          [Markup.button.callback("Cancel", CB.ADD_CONFIRM_CANCEL)],
        ])
      );
    }
  });
}