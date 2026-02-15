import "dotenv/config";
import mongoose from "mongoose";

import { createBot } from "./bot";
import { startServer } from "./health";
import { startScheduler, makeInstanceId } from "./scheduler";
import { startHabitScheduler } from "./habitScheduler";

async function backfillAcknowledgedAtForOldSentOnce() {
  // Run only when explicitly enabled (so it never surprises you)
  if (process.env.RUN_ACK_BACKFILL !== "true") return;

  console.log("[MIGRATION] Backfilling acknowledgedAt for old sent once reminders...");

  // Mark any already-sent one-time reminders as acknowledged so they don't show DUE NOW forever.
  // We set acknowledgedAt to lastRunAt if present, otherwise updatedAt/createdAt.
  const res = await mongoose.connection.collection("reminders").updateMany(
    {
      status: "sent",
      acknowledgedAt: null,
      $or: [
        { schedule: { $exists: false } },
        { schedule: null },
        { "schedule.kind": "once" },
      ],
    },
    [
      {
        $set: {
          acknowledgedAt: {
            $ifNull: ["$lastRunAt", { $ifNull: ["$updatedAt", "$createdAt"] }],
          },
        },
      },
    ] as any
  );

  console.log("[MIGRATION] Backfill complete:", {
    matched: (res as any).matchedCount,
    modified: (res as any).modifiedCount,
  });
}

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
  
  await backfillAcknowledgedAtForOldSentOnce();

  // Start HTTP server with Mini App support
  await startServer({ bot, webhookPath });

  // Webhook URL
  const webhookUrl =
    webhookDomain.endsWith("/")
      ? `${webhookDomain.slice(0, -1)}${webhookPath}`
      : `${webhookDomain}${webhookPath}`;

// Check/set webhook (NON-FATAL on network issues)
try {
  const info = await bot.telegram.getWebhookInfo();
  console.log("Current webhook info:", JSON.stringify(info, null, 2));

  if (info.url !== webhookUrl) {
    console.log("Setting webhook:", webhookUrl);
    await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ["message", "channel_post", "callback_query"],
    });
    console.log("Webhook set successfully.");
  } else {
    console.log("Webhook already correctly configured, skipping setWebhook call.");
  }
} catch (error: any) {
  const code = error?.code;
  const status = error?.response?.error_code;

  // Telegram can be temporarily unreachable (ETIMEDOUT), or rate limit (429)
  console.warn(
    "Webhook check/set failed (continuing without crashing):",
    { code, status, message: error?.message }
  );

  // If you want: only treat auth errors as fatal
  if (status === 401 || status === 404) {
    // 401 = bad token; 404 sometimes appears for invalid bot token formatting
    throw error;
  }
}

  // Log identity
try {
  const me = await bot.telegram.getMe();
  console.log(`Bot identity: @${me.username} ${me.id}`);
} catch (error: any) {
  console.warn(
    "Failed to fetch bot identity (continuing):",
    { code: error?.code, status: error?.response?.error_code, message: error?.message }
  );
}

  // Start DB scheduler loop (checks Mongo for due reminders)
  // Polls every 10 seconds, locks for 60 seconds per reminder
  startScheduler(bot, {
    pollEveryMs: 10_000,     // Check for due reminders every 10 seconds
    lockTtlMs: 60_000,       // Hold lock for 60 seconds (prevents duplicate sends)
    instanceId: makeInstanceId()
  });
  
  // Habit Scheduler
startHabitScheduler(bot, {
  pollEveryMs: 10_000,
  lockTtlMs: 60_000,
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
