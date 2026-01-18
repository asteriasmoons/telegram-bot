// src/routes/telegramRoute.ts
import http from "http";
import { Telegraf } from "telegraf";
import { sendText, normalizePath } from "../server/router";

export function makeTelegramRoutes(bot: Telegraf<any>, webhookPath: string) {
  const cb = bot.webhookCallback(webhookPath);

  return async function telegramRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = (req.method || "GET").toUpperCase();
    const url = normalizePath(req.url || "/");
    const hook = normalizePath(webhookPath);

    // POST webhook
    if (url === hook && method === "POST") {
      cb(req, res);
      return;
    }

    // GET helper
    if (url === hook && method === "GET") {
      sendText(res, 200, "Webhook endpoint is up. Telegram must POST here.");
      return;
    }

    sendText(res, 404, "Not found");
  };
}