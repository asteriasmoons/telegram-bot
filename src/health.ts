import http from "http";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";

import { Reminder } from "./models/Reminder";

type ServerOptions = {
  bot: Telegraf<any>;
  webhookPath: string; // e.g. "/telegram"
};

function normalizePath(rawUrl: string) {
  const pathOnly = rawUrl.split("?")[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) return pathOnly.slice(0, -1);
  return pathOnly;
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendText(res: http.ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    sendText(res, 500, `Missing file: ${filePath}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Telegram Mini App initData validation
 */
function validateInitData(initData: string, botToken: string): Record<string, string> | null {
  const params = new URLSearchParams(initData);

  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  const pairs: string[] = [];
  for (const [key, value] of Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    pairs.push(`${key}=${value}`);
  }
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computed !== hash) return null;

  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function issueMiniAppToken(userId: number) {
  const secret = process.env.MINIAPP_JWT_SECRET;
  if (!secret) throw new Error("Missing MINIAPP_JWT_SECRET");

  const ttlSeconds = Number(process.env.MINIAPP_JWT_TTL_SECONDS || "900");
  return jwt.sign({ userId }, secret, { expiresIn: ttlSeconds });
}

function getBearerToken(req: http.IncomingMessage) {
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

function verifyMiniAppToken(token: string) {
  const secret = process.env.MINIAPP_JWT_SECRET;
  if (!secret) throw new Error("Missing MINIAPP_JWT_SECRET");
  return jwt.verify(token, secret) as any;
}

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  // Mini app file location
  const miniAppIndex = path.join(process.cwd(), "miniapp", "index.html");

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    console.log(`[HTTP] ${method} ${rawUrl}`);

    // Health
    if (url === "/health") {
      sendText(res, 200, "OK");
      return;
    }

    // Mini App page
    if (url === "/app" && method === "GET") {
      sendFile(res, miniAppIndex);
      return;
    }

    // Mini App auth
    if (url === "/miniapp/auth" && method === "POST") {
      try {
        const body = await readJson(req);
        const initData = String(body?.initData || "");

        const botToken = process.env.BOT_TOKEN;
        if (!botToken) return sendJson(res, 500, { error: "Missing BOT_TOKEN" });
        if (!process.env.MINIAPP_JWT_SECRET) return sendJson(res, 500, { error: "Missing MINIAPP_JWT_SECRET" });
        if (!initData) return sendJson(res, 400, { error: "Missing initData" });

        const parsed = validateInitData(initData, botToken);
        if (!parsed) return sendJson(res, 401, { error: "Invalid initData" });

        const userJson = parsed.user;
        if (!userJson) return sendJson(res, 400, { error: "Missing user in initData" });

        let user: any;
        try {
          user = JSON.parse(userJson);
        } catch {
          return sendJson(res, 400, { error: "Bad user payload" });
        }

        const userId = Number(user?.id);
        if (!Number.isFinite(userId)) return sendJson(res, 400, { error: "Bad user id" });

        const token = issueMiniAppToken(userId);

        return sendJson(res, 200, {
          ok: true,
          token,
          user: { id: userId, first_name: user?.first_name, username: user?.username }
        });
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message || "Bad request" });
      }
    }

    // ✅ Phase 2: List reminders for the authed user
    if (url === "/api/reminders" && method === "GET") {
      const tok = getBearerToken(req);
      if (!tok) return sendJson(res, 401, { error: "Missing token" });

      let payload: any;
      try {
        payload = verifyMiniAppToken(tok);
      } catch {
        return sendJson(res, 401, { error: "Invalid token" });
      }

      const userId = Number(payload?.userId);
      if (!Number.isFinite(userId)) return sendJson(res, 401, { error: "Invalid token payload" });

      const reminders = await Reminder.find({
        userId,
        status: { $in: ["scheduled", "paused"] }
      })
        .sort({ nextRunAt: 1 })
        .limit(200)
        .lean();

      return sendJson(res, 200, { ok: true, reminders });
    }

    // Webhook endpoint
    if (url === normalizePath(opts.webhookPath) && method === "POST") {
      webhookCallback(req, res);
      return;
    }

    // Helpful GET on the webhook path
    if (url === normalizePath(opts.webhookPath) && method === "GET") {
      sendText(res, 200, "Webhook endpoint is up. Telegram must POST here.");
      return;
    }

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