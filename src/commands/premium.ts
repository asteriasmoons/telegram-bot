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

  const base = existing?.expiresAt && existing.expiresAt.getTime() > Date.now()
    ? existing.expiresAt
    : new Date();

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
    lines.push("Premium status:");
    if (status.active) {
      lines.push(`Active`);
      if (status.expiresAt) lines.push(`Expires: ${status.expiresAt.toLocaleString("en-US")}`);
    } else {
      lines.push("Not active");
    }

    const text = lines.join("\n");

    await ctx.reply(
      text,
      Markup.inlineKeyboard([
        Markup.button.callback("Buy Premium (30 days)", `buy:${PLAN_30D.id}`),
      ])
    );
  });

  // 2) Button -> send invoice
  bot.action(/^buy:premium_30d$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // IMPORTANT: answer callback so Telegram stops spinner
    await ctx.answerCbQuery();

    // Payload: keep it machine-readable
    const payload = `plan=${PLAN_30D.id}|user=${userId}|ts=${Date.now()}`;

    // Stars invoice:
    // - provider_token MUST be ""
    // - currency MUST be "XTR"
    // - prices must be a single item
    await ctx.replyWithInvoice({
      title: PLAN_30D.title,
      description: PLAN_30D.description,
      payload,
      provider_token: "",
      currency: STARS_CURRENCY,
      prices: [{ label: "Premium (30 days)", amount: PLAN_30D.starsAmount }],
    });
  });

  // 3) Pre-checkout query (required)
  bot.on("pre_checkout_query", async (ctx) => {
    try {
      // You can validate ctx.preCheckoutQuery.invoice_payload here if you want.
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      // If something goes wrong, fail checkout
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

    // For Stars: sp.currency === "XTR"
    // sp.total_amount is the Stars integer amount
    const payload: string = sp.invoice_payload || "";

    // Basic payload check
    if (!payload.includes(`plan=${PLAN_30D.id}`)) {
      // Unknown plan -- don’t grant anything.
      await ctx.reply("Payment received, but the plan could not be verified. Please contact support.");
      return;
    }

    const newExpiry = await activatePremium(userId, PLAN_30D.id, PLAN_30D.days);

    await ctx.reply(
      `Premium activated!\nExpires: ${newExpiry.toLocaleString("en-US")}`
    );
  });
}