import { config } from "./config";
import { connectDb } from "./db";
import { createBot } from "./bot";
import { createScheduler, makeInstanceId } from "./scheduler";
import { startServer } from "./health";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

async function main() {
  // 1) Connect DB
  const conn = await connectDb(config.mongoUri);
  console.log("Connected to MongoDB:", conn.name);

  // 2) Create bot (NO polling launch)
  const bot = createBot(config.botToken);

  // 3) Webhook config
  const webhookDomain = requireEnv("WEBHOOK_DOMAIN"); // e.g. "https://telegram-bot-yt3w.onrender.com"
  const webhookPath = process.env.WEBHOOK_PATH || "/telegram"; // e.g. "/telegram"
  const webhookUrl = `${webhookDomain}${webhookPath}`;

  // 4) Start HTTP server first (Render port binding + webhook receiver)
  const server = startServer({ bot, webhookPath });

  // 5) Register webhook with Telegram
  console.log("Setting webhook:", webhookUrl);
  await bot.telegram.setWebhook(webhookUrl, {
    drop_pending_updates: true
  });
  console.log("Webhook set.");

  const me = await bot.telegram.getMe();
  console.log("Bot identity:", `@${me.username}`, me.id);

  // 6) Start scheduler (DB polling for due reminders/habits)
  const instanceId = process.env.INSTANCE_ID || makeInstanceId();
  const pollIntervalMs = getNumberEnv("SCHEDULER_INTERVAL_MS", 10_000);
  const lockTtlMs = getNumberEnv("SCHEDULER_LOCK_TTL_MS", 60_000);

  const scheduler = createScheduler({
    pollIntervalMs,
    lockTtlMs,
    instanceId
  });

  scheduler.start();

  // 7) Graceful shutdown
  function shutdown(signal: string) {
    console.log(`Shutdown signal received: ${signal}`);
    scheduler.stop();

    try {
      server.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
      });
    } catch (e) {
      console.error("Server close error:", e);
      process.exit(0);
    }
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});