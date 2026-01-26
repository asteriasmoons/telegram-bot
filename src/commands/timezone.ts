// src/commands/timezone.ts (or inline where commands are registered)

import { Telegraf } from "telegraf";
import { DateTime } from "luxon";
import { UserSettings } from "../models/UserSettings";

export function registerTimezoneCommand(bot: Telegraf<any>) {
  bot.command("timezone", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const text = ctx.message?.text || "";
    const parts = text.split(" ").map((p) => p.trim()).filter(Boolean);

    // /timezone
    if (parts.length === 1) {
      const current = await UserSettings.findOne({ userId }).lean();
      const tz = current?.timezone || "America/Chicago";

      await ctx.reply(
        `Your current timezone is:\n\n🕒 *${tz}*\n\n` +
        `To change it, send:\n` +
        `\`/timezone America/New_York\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // /timezone America/New_York
    const tz = parts[1];

    // Validate timezone using Luxon
    const test = DateTime.now().setZone(tz);
    if (!test.isValid) {
      await ctx.reply(
        `❌ That doesn’t look like a valid timezone.\n\n` +
        `Examples:\n` +
        `• America/New_York\n` +
        `• Europe/London\n` +
        `• Australia/Sydney\n\n` +
        `You can find a list here:\nhttps://en.wikipedia.org/wiki/List_of_tz_database_time_zones`
      );
      return;
    }

    // Save (upsert)
    await UserSettings.updateOne(
      { userId },
      { $set: { timezone: tz } },
      { upsert: true }
    );

    // Friendly confirmation
    const preview = test.toFormat("ccc, LLL d • h:mm a");

    await ctx.reply(
      `✅ Timezone updated!\n\n` +
      `🕒 *${tz}*\n` +
      `Current local time: *${preview}*\n\n` +
      `All future reminders will use this timezone.`,
      { parse_mode: "Markdown" }
    );
  });
}