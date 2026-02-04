// src/health.ts
import express from "express";
import path from "path";
import crypto from "crypto";
import type { Telegraf } from "telegraf";

import miniappApiRouter from "./miniapp/api";
import calendarApiRouter from "./miniapp/calendar-api";
import journalApiRouter from "./miniapp/journal-api";
import booksApiRouter from "./miniapp/books-api";
import settingsApiRouter from "./miniapp/settings-api";

import eventShareApiRouter from "./miniapp/eventShare-api";

import habitsRouter from "./miniapp/habits";

import checklistRouter from "./miniapp/checklist-api";

import intentionsApi from "./miniapp/intentions-api";



type StartServerOpts = {
  bot: Telegraf<any>;
  webhookPath: string;
};

function validateTelegramWebAppData(initData: string, botToken: string): number | null {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  urlParams.delete("hash");

  if (!hash) return null;

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) return null;

  const userParam = urlParams.get("user");
  if (!userParam) return null;

  const user = JSON.parse(userParam);
  return user.id;
}

// Mini App auth middleware (sets req.userId)
function miniAppAuth(req: any, res: any, next: any) {
  const initData = req.headers["x-telegram-init-data"] as string;
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) return res.status(500).json({ error: "Bot token not configured" });
  if (!initData) return res.status(401).json({ error: "Missing Telegram init data" });

  const userId = validateTelegramWebAppData(initData, botToken);
  if (!userId) return res.status(401).json({ error: "Invalid Telegram data" });

  req.userId = userId;
  next();
}

export async function startServer({ bot, webhookPath }: StartServerOpts) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  // Health
  app.get("/health", (_req, res) => res.status(200).send("ok"));
  
  // Root (prevents "Cannot GET /" in logs)
app.get("/", (_req, res) => res.status(200).send("ok"));

console.log("[WEBHOOK PATH]", webhookPath);
// Telegram webhook endpoint (primary + alias)
const handler = async (req: any, res: any) => {
  try {
  console.log("[WEBHOOK HIT]", req.path, req.method);
    await bot.handleUpdate(req.body, res);
    if (!res.headersSent) res.sendStatus(200);
  } catch (err) {
    console.error("handleUpdate error:", err);
    if (!res.headersSent) res.sendStatus(200);
  }
};

app.post(webhookPath, handler);

// Safety alias so /telegram always works
app.post("/telegram", handler);

  // ---- Mini App API mounting ----
  // Your existing miniapp API router already has its own auth middleware inside api.ts,
  // BUT we mount it behind miniAppAuth anyway so everything is consistent.
  // This is safe because api.ts auth will just re-check; if you want only one check,
  // we can remove auth from api.ts later.
  app.use("/api/miniapp", miniAppAuth, miniappApiRouter);

  // Calendar and Journal routers rely on req.userId, so they MUST be behind miniAppAuth.
app.use("/api/miniapp/calendar", miniAppAuth, calendarApiRouter);
app.use("/api/miniapp/journal", miniAppAuth, journalApiRouter);
app.use("/api/miniapp/books", miniAppAuth, booksApiRouter);
app.use("/api/miniapp/settings", miniAppAuth, settingsApiRouter);
app.use("/api/miniapp/eventShare", miniAppAuth, eventShareApiRouter);
app.use("/api/miniapp/habits", miniAppAuth, habitsRouter);
app.use("/api/miniapp/checklist", miniAppAuth, checklistRouter);
app.use("/api/miniapp/intentions", miniAppAuth, intentionsRouter);


  // ---- Mini App static files (if you serve them here) ----
  // If you already serve your mini app HTML somewhere else, keep your existing logic.
  // This is a common pattern:
  const publicDir = path.join(process.cwd(), "public");
  app.use(express.static(publicDir));

const PORT = Number(process.env.PORT);

if (!PORT) {
  throw new Error("PORT was not provided by the environment");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server running on port ${PORT}`);
});
}