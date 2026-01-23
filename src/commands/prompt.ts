import type { Telegraf } from "telegraf";
import { claimDailyPrompt } from "../services/promptQuota";
import { generateJournalPrompt } from "../services/groq";

function isDM(ctx: any) {
  return ctx.chat?.type === "private";
}

export function registerPromptCommand(bot: Telegraf<any>) {
  bot.command("prompt", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // If you want DM-only, keep this block.
    // If you want it to work anywhere, delete this block.
    if (!isDM(ctx)) {
      await ctx.reply("For privacy, prompts are available in DM only. Open a DM with me and try /prompt.");
      return;
    }

    try {
      const quota = await claimDailyPrompt(userId);

      if (!quota.allowed) {
        await ctx.reply("You’ve used your 2 prompts for today. Try again tomorrow.");
        return;
      }

      const prompt = await generateJournalPrompt();

      const remainingText =
        typeof quota.remaining === "number" ? `\n\nRemaining today: ${quota.remaining}` : "";

      await ctx.reply(`${prompt}${remainingText}`);
    } catch (err: any) {
      console.error("prompt command error:", err);
      await ctx.reply("Something went wrong generating your prompt. Try again in a moment.");
    }
  });
}