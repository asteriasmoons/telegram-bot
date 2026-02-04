// rules.ts
import { Telegraf, Markup, Context } from "telegraf";

export function setupRules(bot: Telegraf<Context>) {
  const RULES_HTML =
    `<b>Rules & Welcome</b>\n` +
    `This space is intentional, reflective, and community-centered.\n\n` +
    `Hello! Welcome to the Lystaria group chat. Please read all of the rules below:\n\n` +
    `<blockquote>` +
    `(1) <b>Be Respectful</b>\n` +
    `Speak to others with care, even when you disagree. Personal attacks, harassment, or hostile behavior are not welcome here.\n\n` +
    `(2) <b>No Spam or Links</b>\n` +
    `This is not a place for spam, excessive self-promotion, or disruptive behavior. Share thoughtfully and with intention.\n\n` +
    `(3) <b>Stay on Topic.</b>\n` +
    `Please keep conversations aligned with the purpose of the space. Tangents are natural, but repeated derailment isn’t. This space is all about the productivity bot I created. Lystaria.\n\n` +
    `(4) <b>Honor Privacy & Boundaries.</b>\n` +
    `Do not share private conversations, personal information, or content that does not belong to you.\n\n` +
    `(5) <b>No Politics or Religion</b>\n` +
    `These topics tend to polarize and shift the energy of the space, so we ask that they be kept outside the group to maintain a calm and supportive environment.\n\n` +
    `<i>By remaining here, you agree to uphold these values and help maintain a supportive environment. Please press the agree button attached to this medsage.</i>` +
    `</blockquote>\n\n`;

  bot.on("new_chat_members", async (ctx) => {
    const newMembers = ctx.message?.new_chat_members;
    if (!newMembers) return;

    for (const user of newMembers) {
      if (user.is_bot) continue;

      const mention = user.username ? `@${user.username}` : user.first_name || "there";

      await ctx.reply(`Hi ${mention}.\n\n${RULES_HTML}`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          Markup.button.callback("Agree to Rules", `agree_rules:${user.id}`),
        ]),
        disable_web_page_preview: true,
      });
    }
  });

  bot.action(/^agree_rules:(\d+)$/, async (ctx) => {
    const targetUserId = Number(ctx.match[1]);
    const clickerId = ctx.from?.id;

    if (clickerId !== targetUserId) {
      await ctx.answerCbQuery("This button isn’t for you.", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery("Thanks -- noted.");

    // user is not in scope here; use ctx.from
const agreedBy = `<a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>`;

    try {
      await ctx.editMessageText(
        `${agreedBy} agreed to the rules.\n\nPlease enjoy your stay!`,
        { disable_web_page_preview: true }
      );
    } catch {
      await ctx.reply("Agreed. Welcome!");
    }
  });
}