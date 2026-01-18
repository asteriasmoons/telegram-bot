import http from "http";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { sendJson, sendText, readJson, normalizePath } from "../server/router";

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

export function makeMiniAppRoutes() {
  const miniAppIndex = path.join(process.cwd(), "miniapp", "index.html");

  return async function miniappRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    // Serve the mini app HTML at /app
    if (url === "/app" && method === "GET") {
      if (!fs.existsSync(miniAppIndex)) {
        sendText(res, 500, `Missing file: ${miniAppIndex}`);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      fs.createReadStream(miniAppIndex).pipe(res);
      return;
    }

    // Mini App authentication endpoint
    if (url === "/miniapp/auth" && method === "POST") {
      try {
        const body = await readJson(req);
        const initData = String(body?.initData || "");

        const botToken = process.env.BOT_TOKEN;
        if (!botToken) return sendJson(res, 500, { ok: false, error: "Missing BOT_TOKEN" });
        if (!process.env.MINIAPP_JWT_SECRET) return sendJson(res, 500, { ok: false, error: "Missing MINIAPP_JWT_SECRET" });
        if (!initData) return sendJson(res, 400, { ok: false, error: "Missing initData" });

        const parsed = validateInitData(initData, botToken);
        if (!parsed) return sendJson(res, 401, { ok: false, error: "Invalid initData" });

        const userJson = parsed.user;
        if (!userJson) return sendJson(res, 400, { ok: false, error: "Missing user in initData" });

        let user: any;
        try {
          user = JSON.parse(userJson);
        } catch {
          return sendJson(res, 400, { ok: false, error: "Bad user payload" });
        }

        const userId = Number(user?.id);
        if (!Number.isFinite(userId)) return sendJson(res, 400, { ok: false, error: "Bad user id" });

        const token = issueMiniAppToken(userId);

        return sendJson(res, 200, {
          ok: true,
          token,
          user: { id: userId, first_name: user?.first_name, username: user?.username }
        });
      } catch (e: any) {
        return sendJson(res, 400, { ok: false, error: e?.message || "Bad request" });
      }
    }

    // Not handled by this route module
    sendText(res, 404, "Not found");
  };
}