import http from "http";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Telegraf } from "telegraf";
import { DateTime } from "luxon";

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
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getBearerToken(req: http.IncomingMessage) {
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

/**
 * Telegram Mini App initData validation
 * Reference behavior:
 * - initData is URLSearchParams string (Telegram.WebApp.initData)
 * - hash is compared to computed HMAC of sorted key=value pairs (excluding hash)
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

  const ttl = Number(process.env.MINIAPP_JWT_TTL_SECONDS || "900"); // default 15 min
  return jwt.sign({ userId }, secret, { expiresIn: ttl });
}

function verifyMiniAppToken(token: string) {
  const secret = process.env.MINIAPP_JWT_SECRET;
  if (!secret) throw new Error("Missing MINIAPP_JWT_SECRET");
  return jwt.verify(token, secret) as any;
}

function computeNextRunAtFromParts(tz: string, dateISO: string, timeHHMM: string) {
  const dt = DateTime.fromISO(`${dateISO}T${timeHHMM}`, { zone: tz });
  return dt.isValid ? dt.toJSDate() : null;
}

function parseIdFromPath(path: string) {
  // supports:
  // /api/reminders/<id>
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "reminders") return parts[2];
  return null;
}

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const urlPath = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    console.log(`[HTTP] ${method} ${rawUrl}`);

    // --- Health ---
    if (urlPath === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    // --- Telegram Webhook ---
    if (urlPath === normalizePath(opts.webhookPath) && method === "POST") {
      webhookCallback(req, res);
      return;
    }

    if (urlPath === normalizePath(opts.webhookPath) && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Webhook endpoint is up. Telegram must POST here.");
      return;
    }

    // --- Mini App Auth ---
    // POST /miniapp/auth  { initData: string }
    if (urlPath === "/miniapp/auth" && method === "POST") {
      try {
        const body = await readJson(req);
        const initData = String(body?.initData || "");
        const botToken = process.env.BOT_TOKEN;

        if (!botToken) return sendJson(res, 500, { error: "Missing BOT_TOKEN" });
        if (!initData) return sendJson(res, 400, { error: "Missing initData" });

        const parsed = validateInitData(initData, botToken);
        if (!parsed) return sendJson(res, 401, { error: "Invalid initData" });

        const userJson = parsed.user;
        if (!userJson) return sendJson(res, 400, { error: "Missing user" });

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
          token,
          user: { id: userId, first_name: user?.first_name, username: user?.username }
        });
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message || "Bad request" });
      }
    }

    // --- API Auth helper ---
    const requireAuth = () => {
      const tok = getBearerToken(req);
      if (!tok) return { ok: false as const, error: "Missing token" };
      try {
        const payload = verifyMiniAppToken(tok);
        const userId = Number(payload?.userId);
        if (!Number.isFinite(userId)) return { ok: false as const, error: "Invalid token" };
        return { ok: true as const, userId };
      } catch {
        return { ok: false as const, error: "Invalid token" };
      }
    };

    // --- GET /api/reminders ---
    if (urlPath === "/api/reminders" && method === "GET") {
      const auth = requireAuth();
      if (!auth.ok) return sendJson(res, 401, { error: auth.error });

      const reminders = await Reminder.find({
        userId: auth.userId,
        status: { $in: ["scheduled", "paused"] }
      })
        .sort({ nextRunAt: 1 })
        .limit(200)
        .lean();

      return sendJson(res, 200, { reminders });
    }

    // --- PATCH /api/reminders/:id ---
    if (urlPath.startsWith("/api/reminders/") && method === "PATCH") {
      const auth = requireAuth();
      if (!auth.ok) return sendJson(res, 401, { error: auth.error });

      const id = parseIdFromPath(urlPath);
      if (!id) return sendJson(res, 404, { error: "Not found" });

      let body: any = {};
      try {
        body = await readJson(req);
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message || "Invalid JSON" });
      }

      const patch: any = {};

      if (typeof body?.text === "string") patch.text = body.text;
      if (Array.isArray(body?.entities)) patch.entities = body.entities;

      // Enable/disable toggle
      if (body?.status === "scheduled" || body?.status === "paused") {
        patch.status = body.status;
      }

      // Schedule
      if (body?.schedule && typeof body.schedule === "object") {
        patch.schedule = body.schedule;
      }

      // Next run time
      if (typeof body?.nextRunAt === "string") {
        const dt = DateTime.fromISO(body.nextRunAt);
        if (dt.isValid) patch.nextRunAt = dt.toJSDate();
      } else if (typeof body?.dateISO === "string" && typeof body?.timeHHMM === "string") {
        const tz = typeof body?.timezone === "string" ? body.timezone : "America/Chicago";
        patch.timezone = tz;

        const next = computeNextRunAtFromParts(tz, body.dateISO, body.timeHHMM);
        if (!next) return sendJson(res, 400, { error: "Could not compute nextRunAt" });
        patch.nextRunAt = next;

        // keep timeOfDay aligned if daily/weekly
        if (patch.schedule?.kind === "daily") patch.schedule.timeOfDay = body.timeHHMM;
        if (patch.schedule?.kind === "weekly") patch.schedule.timeOfDay = body.timeHHMM;
      }

      const updated = await Reminder.findOneAndUpdate(
        { _id: id, userId: auth.userId, status: { $ne: "deleted" } },
        { $set: patch },
        { new: true }
      ).lean();

      if (!updated) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { reminder: updated });
    }

    // --- DELETE /api/reminders/:id ---
    if (urlPath.startsWith("/api/reminders/") && method === "DELETE") {
      const auth = requireAuth();
      if (!auth.ok) return sendJson(res, 401, { error: auth.error });

      const id = parseIdFromPath(urlPath);
      if (!id) return sendJson(res, 404, { error: "Not found" });

      const result = await Reminder.updateOne(
        { _id: id, userId: auth.userId },
        { $set: { status: "deleted" } }
      );

      if (result.matchedCount === 0) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { ok: true });
    }

    // Default
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bot is running. Use /health for status.");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on port ${port}`);
    console.log(`Health endpoint: /health`);
    console.log(`Webhook endpoint: ${opts.webhookPath}`);
  });

  return server;
}