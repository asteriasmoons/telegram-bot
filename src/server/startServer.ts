// src/server/startServer.ts
import http from "http";
import { Telegraf } from "telegraf";
import { normalizePath, sendText } from "./router";

import { healthRoute } from "../routes/healthRoute";
import { makeTelegramRoutes } from "../routes/telegramRoute";

// We'll add miniappRoute + remindersApiRoute in Phase B
type ServerOptions = {
  bot: Telegraf<any>;
  webhookPath: string;
};

export function startServer(opts: ServerOptions) {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  const telegramRoute = makeTelegramRoutes(opts.bot, opts.webhookPath);

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    console.log(`[HTTP] ${method} ${rawUrl}`);

    if (url === "/health") return healthRoute(req, res);

    // Telegram webhook paths
    if (url === normalizePath(opts.webhookPath)) return telegramRoute(req, res);

    // Default
    sendText(res, 200, "Bot is running. Use /health for status.");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on port ${port}`);
    console.log(`Health endpoint: /health`);
    console.log(`Webhook endpoint: ${opts.webhookPath}`);
  });

  return server;
}