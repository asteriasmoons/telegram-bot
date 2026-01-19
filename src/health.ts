// src/health.ts
// HTTP server with webhook and Mini App support

import express from "express";
import { Telegraf } from "telegraf";
import path from "path";
import miniappRouter from "./miniapp/api";

export async function startServer(opts: { bot: Telegraf<any>; webhookPath: string }) {
  const app = express();
  const port = process.env.PORT || 3000;

  // Parse JSON bodies
  app.use(express.json());

  // CORS for Mini App (if needed)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Telegram-Init-Data");
    next();
  });

  // Telegram webhook endpoint - REMOVE the domain parameter, let Telegraf handle it
  app.use(opts.webhookPath, await opts.bot.createWebhook({ drop_pending_updates: true }));

  // Mini App API routes
  app.use("/api/miniapp", miniappRouter);

  // Serve Mini App static files (HTML/CSS/JS)
  app.use("/miniapp", express.static(path.join(__dirname, "../public/miniapp")));

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ 
      ok: true, 
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Root endpoint
  app.get("/", (req, res) => {
    res.json({ 
      message: "Lystaria Bot API",
      endpoints: {
        health: "/health",
        webhook: opts.webhookPath,
        miniapp: "/miniapp",
        api: "/api/miniapp"
      }
    });
  });

  app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`📱 Mini App: http://localhost:${port}/miniapp`);
    console.log(`🔗 Webhook: ${opts.webhookPath}`);
  });
}
