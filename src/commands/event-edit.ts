import { Telegraf, Markup } from "telegraf";
import { getEvent, listEvents, updateEvent } from "../services/events.service";
import { clearState, getState, setState } from "../state/conversationStore";

function getCbData(ctx: any): string | null {
  const cq = ctx.callbackQuery;
  if (!cq) return null;
  if ("data" in cq && typeof (cq as any).data === "string") return (cq as any).data;
  return null;
}

const CB = {
  CANCEL: "ev:edit:cancel",
  PICK_PREFIX: "ev:edit:pick:",

  MENU: "ev:edit:menu",
  SET_TITLE: "ev:edit:set:title",
  SET_DATE: "ev:edit:set:date",
  SET_TIME: "ev:edit:set:time",
  TOGGLE_ALLDAY: "ev:edit:toggle:allday",
  SET_DESC: "ev:edit:set:desc",
  SET_LOC: "ev:edit:set:loc",
  SET_COLOR: "ev:edit:set:color",
  SAVE: "ev:edit:save",
} as const;

function isValidDateYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidTimeHHMM(s: string) {
  return /^\d{2}:\d{2}$/.test(s);
}
function isHexColor(s: string) {
  return /^#([0-9a-fA-F]{6})$/.test(s);
}

function summary(d: any) {
  const title = d.title || "(not set)";
  const date = d.date || "(not set)";
  const allDay = Boolean(d.allDay);
  const time = allDay ? "(all day)" : (d.time || "(not set)");
  const desc = d.description || "(not set)";
  const loc = d.location || "(not set)";
  const color = d.color || "(not set)";

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

function menuKeyboard(draft: any) {
  const allDayLabel = draft?.allDay ? "All day: ON" : "All day: OFF";
  return Markup.inlineKeyboard([
    [Markup.button.callback("Set title", CB.SET_TITLE)],
    [Markup.button.callback("Set date", CB.SET_DATE)],
    [Markup.button.callback("Set time", CB.SET_TIME)],
    [Markup.button.callback(allDayLabel, CB.TOGGLE_ALLDAY)],
    [Markup.button.callback("Set description", CB.SET_DESC)],
    [Markup.button.callback("Set location", CB.SET_LOC)],
    [Markup.button.callback("Set color", CB.SET_COLOR)],
    [Markup.button.callback("Save", CB.SAVE), Markup.button.callback("Cancel", CB.CANCEL)],
  ]);
}

async function showMenu(ctx: any, userId: number, note?: string) {
  const state = getState(userId);
  const draft = state?.draft || {};
  const text = `${note ? `${note}\n\n` : ""}Event edit menu:\n\n${summary(draft)}`;
  await ctx.reply(text, menuKeyboard(draft));
}

async function sendPickEventList(ctx: any, userId: number) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const events = await listEvents(userId, { startDate: now, endDate: end, limit: 20 });

  if (!events.length) {
    await ctx.reply("No upcoming events found to edit.");
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < events.length; i += 2) {
    const a = events[i];
    const b = events[i + 1];

    const row = [
      Markup.button.callback(`${(a.title || "Untitled").slice(0, 20)}`, `${CB.PICK_PREFIX}${a._id}`),
    ];
    if (b) row.push(Markup.button.callback(`${(b.title || "Untitled").slice(0, 20)}`, `${CB.PICK_PREFIX}${b._id}`));

    rows.push(row);
  }

  rows.push([Markup.button.callback("Cancel", CB.CANCEL)]);

  await ctx.reply("Pick an event to edit:", Markup.inlineKeyboard(rows));
}

export function register(bot: Telegraf) {
  bot.command("eventedit", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    setState(userId, { kind: "event_edit", step: "pick", draft: {} });

    try {
      await sendPickEventList(ctx, userId);
    } catch (e: any) {
      clearState(userId);
      await ctx.reply(`Failed to load events: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(CB.CANCEL, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearState(userId);
    await ctx.answerCbQuery();
    await ctx.reply("Canceled.");
  });

  bot.action(new RegExp(`^${CB.PICK_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "pick") return;

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

      state.step = "menu";
      state.draft = {
        eventId,
        title: ev.title || "",
        description: ev.description || "",
        location: ev.location || "",
        color: ev.color || "",
        allDay: Boolean(ev.allDay),
        date: `${yyyy}-${mm}-${dd}`,
        time: `${hh}:${mins}`,
      };
      setState(userId, state);

      return showMenu(ctx, userId, "Loaded event.");
    } catch (e: any) {
      clearState(userId);
      return ctx.reply(`Failed to load event: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.action(
    [CB.SET_TITLE, CB.SET_DATE, CB.SET_TIME, CB.SET_DESC, CB.SET_LOC, CB.SET_COLOR],
    async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state: any = getState(userId);
      if (!state || state.kind !== "event_edit" || state.step !== "menu") return;

      const data = getCbData(ctx);
      if (!data) return;

      await ctx.answerCbQuery();

      if (data === CB.SET_TITLE) {
        state.step = "await_title";
        setState(userId, state);
        return ctx.reply("Type the new title:");
      }

      if (data === CB.SET_DATE) {
        state.step = "await_date";
        setState(userId, state);
        return ctx.reply("Type the new date (YYYY-MM-DD):");
      }

      if (data === CB.SET_TIME) {
        if (state.draft.allDay) return showMenu(ctx, userId, "Time is ignored when All day is ON.");
        state.step = "await_time";
        setState(userId, state);
        return ctx.reply("Type the new time (HH:MM, 24h):");
      }

      if (data === CB.SET_DESC) {
        state.step = "await_desc";
        setState(userId, state);
        return ctx.reply("Type the new description (or type '-' to clear it):");
      }

      if (data === CB.SET_LOC) {
        state.step = "await_loc";
        setState(userId, state);
        return ctx.reply("Type the new location (or type '-' to clear it):");
      }

      if (data === CB.SET_COLOR) {
        state.step = "await_color";
        setState(userId, state);
        return ctx.reply("Type a hex color like #5b8def (or type '-' to clear it):");
      }
    }
  );

  bot.action(CB.TOGGLE_ALLDAY, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "menu") return;

    state.draft.allDay = !Boolean(state.draft.allDay);
    setState(userId, state);

    await ctx.answerCbQuery();
    return showMenu(ctx, userId, "Updated all-day setting.");
  });

  bot.action(CB.SAVE, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_edit" || state.step !== "menu") return;

    await ctx.answerCbQuery();

    const d = state.draft;
    if (!d.eventId) return showMenu(ctx, userId, "Missing event id (unexpected).");
    if (!d.title || !String(d.title).trim()) return showMenu(ctx, userId, "Missing title.");
    if (!d.date || !isValidDateYYYYMMDD(String(d.date))) return showMenu(ctx, userId, "Missing/invalid date.");
    if (!d.allDay && (!d.time || !isValidTimeHHMM(String(d.time)))) {
      return showMenu(ctx, userId, "Missing/invalid time (or turn All day ON).");
    }

    const startDate = d.allDay
      ? new Date(`${d.date}T00:00:00`)
      : new Date(`${d.date}T${d.time}:00`);

    try {
      await updateEvent(userId, d.eventId, {
        title: String(d.title),
        description: d.description ? String(d.description) : undefined,
        location: d.location ? String(d.location) : undefined,
        color: d.color ? String(d.color) : undefined,
        allDay: Boolean(d.allDay),
        startDate,
      });

      clearState(userId);
      await ctx.reply("Event updated.");
    } catch (e: any) {
      return showMenu(ctx, userId, `Failed to save: ${e?.message ?? "Unknown error"}`);
    }
  });

  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state: any = getState(userId);
    if (!state || state.kind !== "event_edit") return;

    const text = ctx.message.text.trim();

    if (state.step === "await_title") {
      state.draft.title = text;
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Title updated.");
    }

    if (state.step === "await_date") {
      if (!isValidDateYYYYMMDD(text)) return ctx.reply("Invalid date. Use YYYY-MM-DD.");
      state.draft.date = text;
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Date updated.");
    }

    if (state.step === "await_time") {
      if (!isValidTimeHHMM(text)) return ctx.reply("Invalid time. Use HH:MM (24h).");
      state.draft.time = text;
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Time updated.");
    }

    if (state.step === "await_desc") {
      state.draft.description = text === "-" ? "" : text;
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Description updated.");
    }

    if (state.step === "await_loc") {
      state.draft.location = text === "-" ? "" : text;
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Location updated.");
    }

    if (state.step === "await_color") {
      if (text === "-") {
        state.draft.color = "";
      } else {
        if (!isHexColor(text)) return ctx.reply("Invalid color. Use #RRGGBB (example: #5b8def) or '-' to clear.");
        state.draft.color = text;
      }
      state.step = "menu";
      setState(userId, state);
      return showMenu(ctx, userId, "Color updated.");
    }
  });
}