import crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { Reminder } from "./models/Reminder";
import { addMinutes } from "./utils/time";

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");

  const pairs: string[] = [];
  for (const [k, v] of Array.from(params.entries())) {
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();

  const dataCheckString = pairs.join("\n");
  const authDate = Number(params.get("auth_date") || "0");
  const userRaw = params.get("user") || "";

  let user: any = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch { user = null; }

  return { hash, dataCheckString, authDate, user };
}

// Telegram WebApp verification (per Telegram docs)
function verifyTelegramInitData(initData: string, botToken: string, maxAgeSeconds = 60 * 60) {
  const { hash, dataCheckString, authDate, user } = parseInitData(initData);

  if (!hash) return { ok: false, error: "Missing hash in initData." };
  if (!authDate) return { ok: false, error: "Missing auth_date in initData." };
  if (!user?.id) return { ok: false, error: "Missing user in initData." };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - authDate) > maxAgeSeconds) {
    return { ok: false, error: "initData is too old. Close and reopen the mini app." };
  }

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const computed = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computed !== hash) {
    return { ok: false, error: "initData signature check failed." };
  }

  return { ok: true, user };
}

// simple signed token (HMAC) so we can skip JWT for now
function signSession(userId: number, secret: string) {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false as const };
  const [userIdStr, tsStr, sig] = parts;
  const payload = `${userIdStr}.${tsStr}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (expected !== sig) return { ok: false as const };
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId)) return { ok: false as const };
  return { ok: true as const, userId };
}

function getBearer(req: IncomingMessage) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function handleMiniappApi(req: IncomingMessage, res: ServerResponse, botToken: string) {
  const urlObj = new URL(req.url || "/", "http://localhost");
  const pathname = urlObj.pathname;
  const method = (req.method || "GET").toUpperCase();

  const secret = process.env.MINIAPP_SESSION_SECRET || "dev_secret_change_me";

  // POST /miniapp/auth
  if (pathname === "/miniapp/auth" && method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const initData = String(body.initData || "");

    const verified = verifyTelegramInitData(initData, botToken);
    if (!verified.ok) return sendJson(res, 401, { ok: false, error: verified.error });

    const token = signSession(verified.user.id, secret);
    return sendJson(res, 200, { ok: true, token, user: { id: verified.user.id, first_name: verified.user.first_name, username: verified.user.username } });
  }

  // Auth required below
  const bearer = getBearer(req);
  if (!bearer) return sendJson(res, 401, { ok: false, error: "Missing Authorization: Bearer token" });

  const session = verifySession(bearer, secret);
  if (!session.ok) return sendJson(res, 401, { ok: false, error: "Invalid session token" });

  // GET /miniapp/reminders
  if (pathname === "/miniapp/reminders" && method === "GET") {
    const reminders = await Reminder.find({
      userId: session.userId,
      status: "scheduled",
    })
      .sort({ nextRunAt: 1 })
      .limit(50)
      .lean();

    return sendJson(res, 200, { ok: true, reminders });
  }

  // POST /miniapp/reminders/:id/done
  const doneMatch = pathname.match(/^\/miniapp\/reminders\/([^/]+)\/done$/);
  if (doneMatch && method === "POST") {
    const id = doneMatch[1];
    await Reminder.updateOne({ _id: id, userId: session.userId }, { $set: { status: "sent" } });
    return sendJson(res, 200, { ok: true });
  }

  // POST /miniapp/reminders/:id/snooze?minutes=10
  const snoozeMatch = pathname.match(/^\/miniapp\/reminders\/([^/]+)\/snooze$/);
  if (snoozeMatch && method === "POST") {
    const id = snoozeMatch[1];
    const mins = Number(urlObj.searchParams.get("minutes") || "10");
    if (!Number.isFinite(mins) || mins <= 0) return sendJson(res, 400, { ok: false, error: "Invalid minutes" });

    await Reminder.updateOne(
      { _id: id, userId: session.userId },
      { $set: { nextRunAt: addMinutes(new Date(), mins), status: "scheduled" } }
    );

    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: "Unknown miniapp route" });
}