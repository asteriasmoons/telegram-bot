import { config } from "./config";
import { connectDb } from "./db";
import { createBot } from "./bot";
import { startHealthServer } from "./health";

async function main() {
  // 1) Start a tiny HTTP server so Render detects an open port
  startHealthServer();

  // 2) Connect DB
  const conn = await connectDb(config.mongoUri);
  console.log("Connected to MongoDB:", conn.name);

  // 3) Start bot
  const bot = createBot(config.botToken);

  console.log("Clearing webhook (if any)...");
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("Webhook cleared.");

  const me = await bot.telegram.getMe();
  console.log("Bot identity:", `@${me.username}`, me.id);

  await bot.launch({ dropPendingUpdates: true });
  console.log("Bot launched.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
