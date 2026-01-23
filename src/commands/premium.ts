// src/commands/premium.ts
import { Telegraf, Markup } from "telegraf";
import { Premium } from "../models/Premium";

// Stars config
const STARS_CURRENCY = "XTR";
const PLAN_30D = {
  id: "premium_30d",
  title: "Lystaria Premium",
  description: "Unlock higher limits for 30 days.",
  starsAmount: 199, // <- set your Stars price
  days: 30,
};

/**
 * ===============================
 * PUBLIC BASE URL (FOR INVOICE IMAGE)
 * ===============================
 * Invoices cannot upload local images.
 * They ONLY support photo_url (public URL).
 *
 * Because your Express server serves /public as static,
 * your banner at /public/assets/banner.png is reachable at:
 *   https://YOUR-DOMAIN/assets/banner.png
 *
 * Put your Render URL here.
 * (No env var required. Just change the string.)
 */
const PUBLIC_BASE_URL = "https://telegram-bot-yt3w.onrender.com";

/**
 * ===============================
 * INVOICE BANNER URL
 * ===============================
 * Make sure this loads in a normal browser:
 *   https://telegram-bot-yt3w.onrender.com/assets/banner.png
 */
const INVOICE_BANNER_URL = `${PUBLIC_BASE_URL}/assets/banner.png`;

// Helpers
function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function getPremiumStatus(userId: number) {
  const doc = await Premium.findOne({ userId }).lean();
  if (!doc || !doc.isActive) return { active: false as const, expiresAt: null as Date | null };

  if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) {
    // expired => treat as inactive (optional: you can also auto-flip isActive=false in DB)
    return { active: false as const, expiresAt: doc.expiresAt };
  }

  return { active: true as const, expiresAt: doc.expiresAt ?? null };
}

async function activatePremium(userId: number, planId: string, durationDays: number) {
  // If they’re already premium, extend from max(now, expiresAt)
  const existing = await Premium.findOne({ userId });

  const base =
    existing?.expiresAt && existing.expiresAt.getTime() > Date.now() ? existing.expiresAt : new Date();

  const newExpiry = addDays(base, durationDays);

  await Premium.findOneAndUpdate(
    { userId },
    {
      $set: {
        isActive: true,
        expiresAt: newExpiry,
        plan: planId,
        lastPurchaseAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  return newExpiry;
}

// This registers EVERYTHING related to premium
export function registerPremium(bot: Telegraf) {
  // 1) /premium command
  bot.command("premium", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const status = await getPremiumStatus(userId);

    const lines: string[] = [];

    // Status section
    lines.push("Premium status:");
    if (status.active) {
      lines.push("Active");
      if (status.expiresAt) lines.push(`Expires: ${status.expiresAt.toLocaleString("en-US")}`);
    } else {
      lines.push("Not active");
    }

    // Spacer
    lines.push("");

    /*
      ===============================
      ADD YOUR PREMIUM TEXT HERE
      ===============================
      This is a NORMAL MESSAGE (not a photo caption).
      You can write as much as you want here.
    */
    lines.push(
      "Premium exists because limits exist. If 5 people journal heavily everyday then the database I use will start charging for that storage."
    );
    lines.push("");
    lines.push("- Unlimited Journal Entries");
    lines.push("- Unlimited Reminders");
    lines.push("");
    lines.push("Plus supporting my vision! Thank you for your support. It really does make a difference.");

    const text = lines.join("\n");

    await ctx.reply(
      text,
      Markup.inlineKeyboard([Markup.button.callback("Buy Premium (30 days)", `buy:${PLAN_30D.id}`)])
    );
  });

  // 2) Button -> send invoice (WITH PHOTO)
  bot.action(/^buy:premium_30d$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // IMPORTANT: answer callback so Telegram stops spinner
    await ctx.answerCbQuery();

    // Payload: keep it machine-readable
    const payload = `plan=${PLAN_30D.id}|user=${userId}|ts=${Date.now()}`;

    /*
      ===============================
      INVOICE WITH PHOTO
      ===============================
      This is where the banner shows INSIDE the invoice.
      Telegram only supports this via photo_url (public URL).
    */
    await ctx.replyWithInvoice({
      title: PLAN_30D.title,

      // NOTE: Invoice description should be relatively short.
      // Your FULL message is already sent in /premium above.
      description: PLAN_30D.description,

      payload,
      provider_token: "", // Stars requires empty string
      currency: STARS_CURRENCY,
      prices: [{ label: "Premium (30 days)", amount: PLAN_30D.starsAmount }],

      // --- Banner on invoice ---
      photo_url: INVOICE_BANNER_URL,
      // These are optional, but help Telegram size it nicely:
      photo_width: 1280,
      photo_height: 720,
    });
  });

  // 3) Pre-checkout query (required)
  bot.on("pre_checkout_query", async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      await ctx.answerPreCheckoutQuery(false, "Payment verification failed.");
    }
  });

  // 4) Successful payment (required) -> grant premium
  bot.on("message", async (ctx, next) => {
    const msg: any = ctx.message;
    const sp = msg?.successful_payment;
    if (!sp) return next?.();

    const userId = ctx.from?.id;
    if (!userId) return;

    const payload: string = sp.invoice_payload || "";

    // Basic payload check
    if (!payload.includes(`plan=${PLAN_30D.id}`)) {
      await ctx.reply("Payment received, but the plan could not be verified. Please contact support.");
      return;
    }

    const newExpiry = await activatePremium(userId, PLAN_30D.id, PLAN_30D.days);

    await ctx.reply(`Premium activated!\nExpires: ${newExpiry.toLocaleString("en-US")}`);
  });
}