import "dotenv/config";
import mongoose from "mongoose";

import { createBot } from "./bot";
import { startServer } from "./health";
import { startScheduler } from "./scheduler";

async function main() {
  const token = process.env.BOT_TOKEN;
  const mongoUri = process.env.MONGODB_URI;

  // These should be set in Render env vars
  // Example:
  // WEBHOOK_DOMAIN = https://telegram-bot-yt3w.onrender.com
  // WEBHOOK_PATH   = /telegram
  const webhookDomain = process.env.WEBHOOK_DOMAIN;
  const webhookPath = process.env.WEBHOOK_PATH || "/telegram";

  if (!token) throw new Error("Missing BOT_TOKEN");
  if (!mongoUri) throw new Error("Missing MONGODB_URI");
  if (!webhookDomain) throw new Error("Missing WEBHOOK_DOMAIN");

  const bot = createBot(token);

  // Connect DB first
  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  // Start HTTP server (Render needs an open port)
  startServer({ bot, webhookPath });

  // Webhook URL
  const webhookUrl =
    webhookDomain.endsWith("/")
      ? `${webhookDomain.slice(0, -1)}${webhookPath}`
      : `${webhookDomain}${webhookPath}`;

  // IMPORTANT: This is WEBHOOK MODE. No polling.
  console.log("Setting webhook:", webhookUrl);
  await bot.telegram.setWebhook(webhookUrl);
  console.log("Webhook set.");

  // Log identity (helps verify token is correct)
  const me = await bot.telegram.getMe();
  console.log(`Bot identity: @${me.username} ${me.id}`);

  // Start scheduler loop (this is NOT Telegram polling; it's your DB-based scheduler)
  startScheduler(bot, {
    pollIntervalMs: 10_000,
    lockTtlMs: 60_000
  });

  // Graceful shutdown
  process.once("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down...");
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });

  process.once("SIGINT", async () => {
    console.log("SIGINT received, shutting down...");
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});