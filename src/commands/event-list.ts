import { Telegraf, Markup } from "telegraf";
import { listEvents } from "../services/events.service";
import { clearState, setState } from "../state/conversationStore";

/**
 * Callback data strings (kept local so you don't have to edit another file right now)
 * callback_data must stay short (<64 bytes).
 */
const CB_PICK_EVENT_PREFIX = "ev:pick:";          // + <eventId>
const CB_EDIT_FROM_LIST_PREFIX = "ev:editfrom:";  // + <eventId>
const CB_DELETE_FROM_LIST_PREFIX = "ev:delfrom:"; // + <eventId>

function fmtWhen(e: any) {
  const d = new Date(e.startDate);
  if (e.allDay) {
    return `${d.toLocaleDateString()} (all day)`;
  }
  return d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as any);
}

function safeLine(s?: string) {
  return (s || "").trim();
}

export function register(bot: Telegraf) {
  bot.command("eventlist", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Optional: clear any in-progress flow when listing
    clearState(userId);

    try {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 30); // next 30 days (adjust if you want)

      const events = await listEvents(userId, { startDate: now, endDate: end, limit: 50 });

      if (!events.length) {
        return ctx.reply("No upcoming events found. Use /eventadd to create one.");
      }

      await ctx.reply(`Upcoming events (next 30 days): ${events.length}`);

      for (const ev of events) {
        const when = fmtWhen(ev);
        const title = safeLine(ev.title) || "(Untitled)";
        const loc = safeLine(ev.location);
        const desc = safeLine(ev.description);

        const lines = [
          `ID: ${ev._id}`,
          `${when}`,
          `${title}`,
          loc ? `Location: ${loc}` : null,
          desc ? `Description: ${desc}` : null,
        ].filter(Boolean).join("\n");

        await ctx.reply(
          lines,
          Markup.inlineKeyboard([
            [
              Markup.button.callback("Edit", `${CB_EDIT_FROM_LIST_PREFIX}${ev._id}`),
              Markup.button.callback("Delete", `${CB_DELETE_FROM_LIST_PREFIX}${ev._id}`),
            ],
          ])
        );
      }
    } catch (err: any) {
      return ctx.reply(`Failed to list events: ${err?.message ?? "Unknown error"}`);
    }
  });

  /**
   * Edit button directly from list
   * Sets edit flow state and prompts field selection (event-edit file handles the rest too,
   * but we keep this handler here so list feels complete).
   */
  bot.action(new RegExp(`^${CB_EDIT_FROM_LIST_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const data = ctx.callbackQuery.data;
    const eventId = data.slice(CB_EDIT_FROM_LIST_PREFIX.length);

    // Hand off to edit flow
    setState(userId, {
      kind: "event_edit",
      step: "pick_field",
      draft: { eventId },
    });

    await ctx.answerCbQuery();
    await ctx.reply(
      "Edit: What do you want to change?",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Title", "ev:edit:field:title"),
          Markup.button.callback("Date", "ev:edit:field:date"),
          Markup.button.callback("Time", "ev:edit:field:time"),
        ],
        [
          Markup.button.callback("All day", "ev:edit:field:allDay"),
          Markup.button.callback("Description", "ev:edit:field:description"),
        ],
        [
          Markup.button.callback("Location", "ev:edit:field:location"),
          Markup.button.callback("Color", "ev:edit:field:color"),
        ],
        [Markup.button.callback("Cancel", "ev:edit:confirm:cancel")],
      ])
    );
  });

  /**
   * Delete button from list (we're implementing delete in the NEXT message).
   * For now: acknowledge and tell user it's next.
   */
  bot.action(new RegExp(`^${CB_DELETE_FROM_LIST_PREFIX}[0-9a-fA-F]{24}$`), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Delete is next -- we’ll wire that command/flow in the next step.");
  });
}