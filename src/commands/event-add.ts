import { Telegraf, Markup } from "telegraf";
import { createEvent } from "../services/events.service";

/**
 * In-memory flow state (no conversationStore).
 * This resets on bot restart -- that’s fine for short interactive flows.
 */
type Step =
  | "menu"
  | "title"
  | "date"
  | "time"
  | "description"
  | "location"
  | "color"
  | "confirm";

type EventDraft = {
  title?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  allDay?: boolean;
  description?: string;
  location?: string;
  color?: string; // #RRGGBB
};

type FlowState = {
  step: Step;
  draft: EventDraft;
  // which field we’re currently expecting text for
  expect?: "title" | "date" | "time" | "description" | "location" | "color";
};

const flow = new Map<number, FlowState>();

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
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
  CREATE: "ev:add:create",
  CONFIRM_YES: "ev:add:confirm:yes",
  CONFIRM_NO: "ev:add:confirm:no",
  CANCEL: "ev:add:cancel",
} as const;

function summary(d: EventDraft) {
  const title = d.title?.trim() ? d.title.trim() : "(not set)";
  const date = d.date?.trim() ? d.date.trim() : "(not set)";
  const allDay = Boolean(d.allDay);
  const time = allDay ? "(all day)" : (d.time?.trim() ? d.time.trim() : "(not set)");
  const desc = d.description?.trim() ? d.description.trim() : "(not set)";
  const loc = d.location?.trim() ? d.location.trim() : "(not set)";
  const color = d.color?.trim() ? d.color.trim() : "(not set)";

  return [
    `Title: ${title}`,
    `Date: ${date}`,
    `Time: ${time}`,
    `All day: ${allDay ? "Yes" : "No"}`,
    `Description: ${desc}`,
    `Location: ${loc}`,
    `Color: ${color}`,
  ].join("\n");
}

function menuKeyboard(draft: EventDraft) {
  const allDayLabel = draft.allDay ? "All day: ON" : "All day: OFF";

  return Markup.inlineKeyboard([
    [Markup.button.callback("Set title", CB.SET_TITLE)],
    [Markup.button.callback("Set date", CB.SET_DATE)],
    [Markup.button.callback("Set time", CB.SET_TIME)],
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
    [Markup.button.callback("Create", CB.CREATE)],
    [Markup.button.callback("Cancel", CB.CANCEL)],
  ]);
}

async function showMenu(ctx: any, userId: number, note?: string) {
  const state = flow.get(userId);
  const draft = state?.draft ?? {};

  const text = `${note ? `${note}\n\n` : ""}Event add:\n\n${summary(draft)}`;
  await ctx.reply(text, menuKeyboard(draft));
}

function requireUser(ctx: any): number | null {
  const userId = ctx.from?.id;
  return typeof userId === "number" ? userId : null;
}

export function register(bot: Telegraf) {
  // /eventadd
  bot.command("eventadd", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.set(userId, { step: "menu", draft: { allDay: false } });
    await showMenu(ctx, userId);
  });

  // Cancel
  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  // Toggle all-day
  bot.action(CB.TOGGLE_ALLDAY, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st) return;

    st.draft.allDay = !Boolean(st.draft.allDay);

    // If switching to all-day, time becomes irrelevant; keep it but it won’t be required
    st.step = "menu";
    st.expect = undefined;

    flow.set(userId, st);

    await ctx.answerCbQuery();
    await showMenu(ctx, userId, "Updated all-day setting.");
  });

  // Clear actions
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

  // Set field actions -> switch to "expecting text"
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

  // Create -> confirm screen
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

  // Confirm yes -> create in DB
  bot.action(CB.CONFIRM_YES, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || st.step !== "confirm") return;

    await ctx.answerCbQuery();

    const d = st.draft;

    const date = d.date!.trim();
    const startDate = d.allDay
      ? new Date(`${date}T00:00:00`)
      : new Date(`${date}T${d.time!.trim()}:00`);

    try {
      const doc = await createEvent(userId, {
        title: d.title!.trim(),
        description: d.description?.trim() ? d.description.trim() : undefined,
        location: d.location?.trim() ? d.location.trim() : undefined,
        color: d.color?.trim() ? d.color.trim() : undefined,
        allDay: Boolean(d.allDay),
        startDate,
      });

      flow.delete(userId);
      await ctx.reply(`Event created.\nID: ${doc._id}`);
    } catch (e: any) {
      st.step = "menu";
      flow.set(userId, st);
      await showMenu(ctx, userId, `Failed to create: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Text handler (only when we’re expecting a typed value)
  bot.on("text", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || !st.expect) return;

    const input = ctx.message.text.trim();

    if (st.expect === "title") {
      st.draft.title = input;
    }

    if (st.expect === "date") {
      if (!isValidDateYYYYMMDD(input)) return ctx.reply("Invalid date. Use YYYY-MM-DD.");
      st.draft.date = input;
    }

    if (st.expect === "time") {
      if (!isValidTimeHHMM(input)) return ctx.reply("Invalid time. Use HH:MM (24h).");
      st.draft.time = input;
    }

    if (st.expect === "description") {
      st.draft.description = input === "-" ? "" : input;
    }

    if (st.expect === "location") {
      st.draft.location = input === "-" ? "" : input;
    }

    if (st.expect === "color") {
      if (input === "-") {
        st.draft.color = "";
      } else {
        if (!isHexColor(input)) return ctx.reply("Invalid color. Use #RRGGBB or '-' to clear.");
        st.draft.color = input;
      }
    }

    // Return to menu
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showMenu(ctx, userId, "Updated.");
  });
}