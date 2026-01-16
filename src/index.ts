import { config } from "./config";
import { connectDb } from "./db";
import { createBot } from "./bot";

async function main() {
  const conn = await connectDb(config.mongoUri);
  console.log("Connected to MongoDB:", conn.name);

  const bot = createBot(config.botToken);

  // Graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch();
  console.log("Bot launched.");
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
