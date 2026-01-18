import "dotenv/config";
import mongoose from "mongoose";

import { createBot } from "./bot";
import { startServer } from "./server/startServer";
import { startScheduler, makeInstanceId } from "./scheduler";

async function main() {
const token = process.env.BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;

// Render env vars:
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

// IMPORTANT: WEBHOOK MODE. No Telegram polling.
console.log("Setting webhook:", webhookUrl);
await bot.telegram.setWebhook(webhookUrl, {
  allowed_updates: ["message", "channel_post", "callback_query"],
});
console.log("Webhook set.");
const info = await bot.telegram.getWebhookInfo();
console.log("Webhook info:", JSON.stringify(info, null, 2));

// Log identity
const me = await bot.telegram.getMe();
console.log(`Bot identity: @${me.username} ${me.id}`);

// Start DB scheduler loop (checks Mongo for due reminders)
// Polls every 10 seconds, locks for 60 seconds per reminder
startScheduler(bot, {
pollEveryMs: 10_000,     // Check for due reminders every 10 seconds
lockTtlMs: 60_000,       // Hold lock for 60 seconds (prevents duplicate sends)
instanceId: makeInstanceId()
});

// Graceful shutdown
process.once("SIGTERM", async () => {
console.log("SIGTERM received, shutting down…");
await mongoose.disconnect().catch(() => {});
process.exit(0);
});

process.once("SIGINT", async () => {
console.log("SIGINT received, shutting down…");
await mongoose.disconnect().catch(() => {});
process.exit(0);
});
}

main().catch((err) => {
console.error("Fatal startup error:", err);
process.exit(1);
});