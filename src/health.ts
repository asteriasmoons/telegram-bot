import http from "http";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import { handleMiniappApi } from "./miniappApi";

type ServerOptions = {
  bot: Telegraf<any>;
  webhookPath: string; // e.g. "/telegram"
};

function normalizePath(rawUrl: string) {
  const pathOnly = rawUrl.split("?")[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) return pathOnly.slice(0, -1);
  return pathOnly;
}

function contentTypeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function safeJoin(base: string, target: string) {
  const targetPath = path.posix.normalize("/" + target).replace(/^\/+/, "");
  const joined = path.join(base, targetPath);
  if (!joined.startsWith(base)) return null;
  return joined;
}

function serveFile(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found.");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  // prevent weird caching while you're iterating
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(filePath).pipe(res);
}

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  // IMPORTANT: miniapp folder lives at project root: ./miniapp
  // Use process.cwd() so it still works from dist/ on Render.
  const MINIAPP_DIR = path.join(process.cwd(), "miniapp");
  const MINIAPP_INDEX = path.join(MINIAPP_DIR, "index.html");

  const server = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const url = normalizePath(rawUrl);
    const method = (req.method || "GET").toUpperCase();

    console.log(`[HTTP] ${method} ${rawUrl}`);

    // Health
    if (url === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    // Telegram webhook
    if (url === normalizePath(opts.webhookPath) && method === "POST") {
      webhookCallback(req, res);
      return;
    }

    // Helpful GET on the webhook path
    if (url === normalizePath(opts.webhookPath) && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Webhook endpoint is up. Telegram must POST here.");
      return;
    }

    // Redirect old /miniapp links to /app so you don't accidentally open the wrong thing
    if ((url === "/miniapp" || url.startsWith("/miniapp/")) && method === "GET") {
      res.statusCode = 302;
      res.setHeader("Location", "/app");
      res.end();
      return;
    }

    // ✅ API for the miniapp
    // All miniapp backend endpoints should live under /app/api/*
    if (url.startsWith("/app/api")) {
      const botToken = process.env.BOT_TOKEN;
      if (!botToken) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "Missing BOT_TOKEN" }));
        return;
      }
      handleMiniappApi(req, res, botToken);
      return;
    }

    // ✅ Serve the miniapp at /app
    if (url === "/app" && method === "GET") {
      serveFile(res, MINIAPP_INDEX);
      return;
    }

    // ✅ Serve miniapp static assets at /app/<file>
    if (url.startsWith("/app/") && method === "GET") {
      const rel = url.replace(/^\/app\/?/, "");
      const filePath = rel ? safeJoin(MINIAPP_DIR, rel) : MINIAPP_INDEX;

      if (!filePath) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Bad path.");
        return;
      }

      const resolvedPath =
        fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
          ? path.join(filePath, "index.html")
          : filePath;

      serveFile(res, resolvedPath);
      return;
    }

    // Default (this should NOT be what the miniapp hits)
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bot is running. Use /health for status.");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on port ${port}`);
    console.log(`Health endpoint: /health`);
    console.log(`Webhook endpoint: ${opts.webhookPath}`);
    console.log(`Mini app endpoint: /app`);
    console.log(`Mini app API base: /app/api`);
  });

  return server;
}