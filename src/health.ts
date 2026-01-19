import http from "http";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";

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
  // Prevent path traversal
  const targetPath = path.posix.normalize("/" + target).replace(/^\/+/, "");
  const joined = path.join(base, targetPath);
  if (!joined.startsWith(base)) return null;
  return joined;
}

function sendRedirect(res: http.ServerResponse, location: string) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function sendFile(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  fs.createReadStream(filePath).pipe(res);
}

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  // miniapp folder at repo root: ./miniapp
  const MINIAPP_DIR = path.join(process.cwd(), "miniapp");
  const INDEX_HTML = path.join(MINIAPP_DIR, "index.html");

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

    // Helpful GET on webhook path
    if (url === normalizePath(opts.webhookPath) && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Webhook endpoint is up. Telegram must POST here.");
      return;
    }

    // --- CANONICAL MINIAPP ROUTE: /app ---
    // Serve the app shell
    if ((url === "/app" || url === "/app/") && method === "GET") {
      return sendFile(res, INDEX_HTML);
    }

    // Serve static assets under /app/*
    if (url.startsWith("/app/") && method === "GET") {
      const rel = url.replace(/^\/app\/+/, ""); // e.g. "app.css"
      const filePath = safeJoin(MINIAPP_DIR, rel);

      if (!filePath) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Bad path.");
        return;
      }

      return sendFile(res, filePath);
    }

    // --- COMPAT REDIRECTS (because humans will try these) ---
    // If you hit /miniapp, force you onto /app
    if ((url === "/miniapp" || url === "/miniapp/") && method === "GET") {
      return sendRedirect(res, "/app");
    }
    if (url.startsWith("/miniapp/") && method === "GET") {
      const rel = url.replace(/^\/miniapp\/+/, "");
      return sendRedirect(res, `/app/${rel}`);
    }

    // If you hit /app.css or /app.js by accident, route it properly
    if (url === "/app.css" && method === "GET") return sendRedirect(res, "/app/app.css");
    if (url === "/app.js" && method === "GET") return sendRedirect(res, "/app/app.js");

    // Default
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bot is running. Use /health for status.");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on port ${port}`);
    console.log(`Health endpoint: /health`);
    console.log(`Webhook endpoint: ${opts.webhookPath}`);
    console.log(`Mini app endpoint: /app`);
    console.log(`Mini app dir: ${MINIAPP_DIR}`);
  });

  return server;
}