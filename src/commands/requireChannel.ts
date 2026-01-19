import { Context } from "telegraf";

const REQUIRED_CHANNEL = "@lystaria";

export async function requireChannel(ctx: Context, next?: () => Promise<void>) {
  try {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Check membership
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, userId);

    const isMember =
      member.status === "member" ||
      member.status === "administrator" ||
      member.status === "creator";

    if (!isMember) {
      await ctx.reply(
        "Hello. To use this bot, please join our channel first. It is the greatest way for you to receive updates, report bugs and send in feature requests all in one place.\n\nOnce you’ve joined, tap the **Refresh** button below.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Join Channel",
                  url: `https://t.me/${REQUIRED_CHANNEL.replace("@", "")}`,
                },
              ],
              [
                {
                  text: "Refresh",
                  callback_data: "check_channel",
                },
              ],
            ],
          },
        }
      );

      return;
    }

    // User IS a member → continue
    if (next) {
      return next();
    }
  } catch (err) {
    console.error("Channel check failed:", err);
    await ctx.reply("Unable to verify channel membership. Please try again.");
  }
}