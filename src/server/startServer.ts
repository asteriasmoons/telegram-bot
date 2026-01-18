import http from "http";
import { Telegraf } from "telegraf";
import { normalizePath, sendText } from "./router";

import { healthRoute } from "../routes/healthRoute";
import { makeTelegramRoutes } from "../routes/telegramRoute";
import { makeMiniAppRoutes } from "../routes/miniappRoute";
import { makeRemindersApiRoutes } from "../routes/remindersApiRoute";

type ServerOptions = {
  bot: Telegraf<any>;
  webhookPath: string;
};

export function startServer(opts: ServerOptions) {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  const telegramRoute = makeTelegramRoutes(opts.bot, opts.webhookPath);
  const miniappRoute = makeMiniAppRoutes();
  const remindersApiRoute = makeRemindersApiRoutes();

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    console.log(`[HTTP] ${method} ${rawUrl}`);

    // Health
    if (url === "/health") return healthRoute(req, res);

    // Mini App: /app and /miniapp/auth
    if (url === "/app" || url === "/miniapp/auth") return miniappRoute(req, res);

    // Mini App API: /api/reminders
    if (url === "/api/reminders") return remindersApiRoute(req, res);

    // Telegram webhook path
    if (url === normalizePath(opts.webhookPath)) return telegramRoute(req, res);

    // Default
    sendText(res, 200, "Bot is running. Use /health for status.");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on port ${port}`);
    console.log(`Health endpoint: /health`);
    console.log(`Mini App page: /app`);
    console.log(`Mini App auth: POST /miniapp/auth`);
    console.log(`Mini App reminders: GET /api/reminders`);
    console.log(`Webhook endpoint: ${opts.webhookPath}`);
  });

  return server;
}