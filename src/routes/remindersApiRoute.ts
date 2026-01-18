import http from "http";
import jwt from "jsonwebtoken";
import { Reminder } from "../models/Reminder";
import { sendJson, sendText, normalizePath } from "../server/router";

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

async function requireUserId(req: http.IncomingMessage, res: http.ServerResponse): Promise<number | null> {
  const tok = getBearerToken(req);
  if (!tok) {
    sendJson(res, 401, { ok: false, error: "Missing token" });
    return null;
  }

  try {
    const payload: any = verifyMiniAppToken(tok);
    const userId = Number(payload?.userId);
    if (!Number.isFinite(userId)) {
      sendJson(res, 401, { ok: false, error: "Invalid token payload" });
      return null;
    }
    return userId;
  } catch {
    sendJson(res, 401, { ok: false, error: "Invalid token" });
    return null;
  }
}

export function makeRemindersApiRoutes() {
  return async function remindersApiRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    // GET /api/reminders
    if (url === "/api/reminders" && method === "GET") {
      const userId = await requireUserId(req, res);
      if (!userId) return;

      const reminders = await Reminder.find({
        userId,
        status: "scheduled"
      })
        .sort({ nextRunAt: 1 })
        .limit(200)
        .lean();

      sendJson(res, 200, { ok: true, reminders });
      return;
    }

    sendText(res, 404, "Not found");
  };
}