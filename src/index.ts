import { config } from "./config";
import { connectDb } from "./db";
import { createBot } from "./bot";
import { startHealthServer } from "./health";
import { createScheduler, makeInstanceId } from "./scheduler";

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

async function launchBotWithRetry() {
  const bot = createBot(config.botToken);

  console.log("Clearing webhook (if any)...");
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("Webhook cleared.");

  const me = await bot.telegram.getMe();
  console.log("Bot identity:", `@${me.username}`, me.id);

  while (true) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log("Bot launched.");
      break;
    } catch (e: any) {
      const msg = String(e?.message || e);
      const is409 = msg.includes("409") && msg.toLowerCase().includes("conflict");

      console.error("Bot launch error:", msg);

      if (is409) {
        console.error(
          "Telegram 409 Conflict: another instance is polling getUpdates. Stop the other instance."
        );
        await sleep(5000);
        continue;
      }

      throw e;
    }
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

async function main() {
  // Keep Render happy (open port)
  startHealthServer();

  // DB connection
  const conn = await connectDb(config.mongoUri);
  console.log("Connected to MongoDB:", conn.name);

  // Bot launch
  await launchBotWithRetry();

  // Scheduler config (env-controlled)
  const pollIntervalMs = getNumberEnv("SCHEDULER_INTERVAL_MS", 10_000);
  const lockTtlMs = getNumberEnv("SCHEDULER_LOCK_TTL_MS", 60_000);
  const instanceId = process.env.INSTANCE_ID || makeInstanceId();

  const scheduler = createScheduler({
    pollIntervalMs,
    lockTtlMs,
    instanceId
  });

  scheduler.start();

  process.once("SIGINT", () => scheduler.stop());
  process.once("SIGTERM", () => scheduler.stop());
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
});