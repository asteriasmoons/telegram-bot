import { config } from "./config";
import { connectDb } from "./db";
import { createBot } from "./bot";
import { startHealthServer } from "./health";
import { createScheduler, makeInstanceId } from "./scheduler";
import { createInstanceLock } from "./instanceLock";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

async function main() {
  // Keep Render happy
  startHealthServer();

  // DB connection
  const conn = await connectDb(config.mongoUri);
  console.log("Connected to MongoDB:", conn.name);

  const instanceId = process.env.INSTANCE_ID || makeInstanceId();

  // Acquire a distributed lock BEFORE launching polling
  const lock = createInstanceLock({
    key: "telegram_polling_lock",
    instanceId,
    leaseMs: 60_000,
    renewEveryMs: 20_000
  });

  await lock.waitForAcquire();
  lock.startRenewal();

  const bot = createBot(config.botToken);

  console.log("Clearing webhook (if any)...");
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("Webhook cleared.");

  const me = await bot.telegram.getMe();
  console.log("Bot identity:", `@${me.username}`, me.id);

  // Now safe: we are the only poller allowed to launch
  await bot.launch({ dropPendingUpdates: true });
  console.log("Bot launched.");

  // Start scheduler (polling DB for due reminders/habits)
  const pollIntervalMs = getNumberEnv("SCHEDULER_INTERVAL_MS", 10_000);
  const lockTtlMs = getNumberEnv("SCHEDULER_LOCK_TTL_MS", 60_000);

  const scheduler = createScheduler({
    pollIntervalMs,
    lockTtlMs,
    instanceId
  });

  scheduler.start();

  async function shutdown(signal: string) {
    console.log(`Shutdown signal received: ${signal}`);

    scheduler.stop();

    try {
      bot.stop(signal);
    } catch (e) {
      console.error("Bot stop error:", e);
    }

    await lock.release();

    // Small delay to let logs flush
    await sleep(250);

    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});