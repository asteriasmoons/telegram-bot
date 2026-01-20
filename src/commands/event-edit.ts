import { Telegraf, Markup } from "telegraf";
import { getEvent, listEvents, updateEvent } from "../services/events.service";

/**
 * In-memory flow state (no conversationStore).
 * Resets on bot restart -- acceptable for short interactive flows.
 */
type Step =
  | "pick_event"
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
  eventId?: string;
  draft: EventDraft;
  expect?: "title" | "date" | "time" | "description" | "location" | "color";
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

const CB = {
  CANCEL: "ev:edit:cancel",
  REFRESH: "ev:edit:refresh",
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

  SAVE: "ev:edit:save",
  CONFIRM_YES: "ev:edit:confirm:yes",
  CONFIRM_NO: "ev:edit:confirm:no",
} as const;

function summary(d: EventDraft, eventId?: string) {
  const title = d.title?.trim() ? d.title.trim() : "(not set)";
  const date = d.date?.trim() ? d.date.trim() : "(not set)";
  const allDay = Boolean(d.allDay);
  const time = allDay ? "(all day)" : (d.time?.trim() ? d.time.trim() : "(not set)");
  const desc = d.description?.trim() ? d.description.trim() : "(not set)";
  const loc = d.location?.trim() ? d.location.trim() : "(not set)";
  const color = d.color?.trim() ? d.color.trim() : "(not set)";

  return [
    `ID: ${eventId ?? "(not selected)"}`,
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
    [Markup.button.callback("Save changes", CB.SAVE)],
    [Markup.button.callback("Cancel", CB.CANCEL)],
  ]);
}

async function showMenu(ctx: any, userId: number, note?: string) {
  const st = flow.get(userId);
  if (!st) return;

  const text = `${note ? `${note}\n\n` : ""}Event edit:\n\n${summary(st.draft, st.eventId)}`;
  await ctx.reply(text, menuKeyboard(st.draft));
}

async function sendPickList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 60);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 24 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to edit.");
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < events.length; i += 2) {
    const a = events[i];
    const b = events[i + 1];

    const aLabel = `${(a.title || "Untitled").slice(0, 18)}`;
    const row = [Markup.button.callback(aLabel, `${CB.PICK_PREFIX}${a._id}`)];

    if (b) {
      const bLabel = `${(b.title || "Untitled").slice(0, 18)}`;
      row.push(Markup.button.callback(bLabel, `${CB.PICK_PREFIX}${b._id}`));
    }

    rows.push(row);
  }

  rows.push([Markup.button.callback("Refresh list", CB.REFRESH)]);
  rows.push([Markup.button.callback("Cancel", CB.CANCEL)]);

  await ctx.reply("Pick an event to edit:", Markup.inlineKeyboard(rows));
}

export function register(bot: Telegraf) {
  // /eventedit
  bot.command("eventedit", async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.set(userId, { step: "pick_event", draft: {} });

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    flow.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(CB.REFRESH, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st) return;

    st.step = "pick_event";
    st.eventId = undefined;
    st.draft = {};
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();

    try {
      await sendPickList(ctx, userId);
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Pick event
  bot.action(new RegExp(`^${CB.PICK_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st) return;

    const data = getCbData(ctx);
    if (!data) return;

    const eventId = data.slice(CB.PICK_PREFIX.length);

    await ctx.answerCbQuery();

    try {
      const ev = await getEvent(userId, eventId);

      const start = new Date(ev.startDate);

      const yyyy = start.getFullYear();
      const mm = String(start.getMonth() + 1).padStart(2, "0");
      const dd = String(start.getDate()).padStart(2, "0");
      const hh = String(start.getHours()).padStart(2, "0");
      const mins = String(start.getMinutes()).padStart(2, "0");

      st.eventId = eventId;
      st.step = "menu";
      st.expect = undefined;
      st.draft = {
        title: ev.title || "",
        description: ev.description || "",
        location: ev.location || "",
        color: ev.color || "",
        allDay: Boolean(ev.allDay),
        date: `${yyyy}-${mm}-${dd}`,
        time: `${hh}:${mins}`,
      };

      flow.set(userId, st);

      await showMenu(ctx, userId, "Loaded event.");
    } catch (e: any) {
      flow.delete(userId);
      await ctx.reply(`Failed to load event: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Clear actions
  bot.action([CB.CLEAR_DESC, CB.CLEAR_LOC, CB.CLEAR_COLOR], async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || !st.eventId) return;

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

  // Toggle all-day
  bot.action(CB.TOGGLE_ALLDAY, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || !st.eventId) return;

    st.draft.allDay = !Boolean(st.draft.allDay);
    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    await ctx.answerCbQuery();
    await showMenu(ctx, userId, "Updated all-day setting.");
  });

  // Set field actions -> expect typed value
  bot.action(
    [CB.SET_TITLE, CB.SET_DATE, CB.SET_TIME, CB.SET_DESC, CB.SET_LOC, CB.SET_COLOR],
    async (ctx) => {
      const userId = requireUser(ctx);
      if (!userId) return;

      const st = flow.get(userId);
      if (!st || !st.eventId) return;

      const data = getCbData(ctx);
      if (!data) return;

      await ctx.answerCbQuery();

      if (data === CB.SET_TITLE) {
        st.step = "title";
        st.expect = "title";
        flow.set(userId, st);
        return ctx.reply("Type the new title:");
      }

      if (data === CB.SET_DATE) {
        st.step = "date";
        st.expect = "date";
        flow.set(userId, st);
        return ctx.reply("Type the new date as YYYY-MM-DD:");
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
        return ctx.reply("Type the new time as HH:MM (24h):");
      }

      if (data === CB.SET_DESC) {
        st.step = "description";
        st.expect = "description";
        flow.set(userId, st);
        return ctx.reply("Type the new description (send a single '-' to clear):");
      }

      if (data === CB.SET_LOC) {
        st.step = "location";
        st.expect = "location";
        flow.set(userId, st);
        return ctx.reply("Type the new location (send a single '-' to clear):");
      }

      if (data === CB.SET_COLOR) {
        st.step = "color";
        st.expect = "color";
        flow.set(userId, st);
        return ctx.reply("Type a hex color like #5b8def (send a single '-' to clear):");
      }
    }
  );

  // Save -> confirm
  bot.action(CB.SAVE, async (ctx) => {
    const userId = requireUser(ctx);
    if (!userId) return;

    const st = flow.get(userId);
    if (!st || !st.eventId) return;

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
      "Confirm save?\n\n" + summary(d, st.eventId),
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, save", CB.CONFIRM_YES)],
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
    if (!st || st.step !== "confirm" || !st.eventId) return;

    await ctx.answerCbQuery();

    const d = st.draft;
    const date = d.date!.trim();

    const startDate = d.allDay
      ? new Date(`${date}T00:00:00`)
      : new Date(`${date}T${d.time!.trim()}:00`);

    try {
      await updateEvent(userId, st.eventId, {
        title: d.title!.trim(),
        description: d.description?.trim() ? d.description.trim() : undefined,
        location: d.location?.trim() ? d.location.trim() : undefined,
        color: d.color?.trim() ? d.color.trim() : undefined,
        allDay: Boolean(d.allDay),
        startDate,
      });

      flow.delete(userId);
      await ctx.reply("Event updated.");
    } catch (e: any) {
      st.step = "menu";
      flow.set(userId, st);
      await showMenu(ctx, userId, `Failed to save: ${e?.message ?? "Unknown error"}`);
    }
  });

  // Text handler (only when expecting typed value)
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

    st.step = "menu";
    st.expect = undefined;
    flow.set(userId, st);

    return showMenu(ctx, userId, "Updated.");
  });
}