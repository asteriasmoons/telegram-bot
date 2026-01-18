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
  // Prevent path traversal: /miniapp/../../etc/passwd
  const targetPath = path.posix.normalize("/" + target).replace(/^\/+/, "");
  const joined = path.join(base, targetPath);
  if (!joined.startsWith(base)) return null;
  return joined;
}

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  // IMPORTANT: miniapp folder lives at project root: ./miniapp
  // Use process.cwd() so it works after TS build (dist/) on Render.
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

    // ✅ Mini App hosting
    // Serve /miniapp and /miniapp/ as the index.html
    if ((url === "/miniapp" || url === "/miniapp/") && method === "GET") {
      if (!fs.existsSync(MINIAPP_INDEX)) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Mini app index.html not found on server.");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      fs.createReadStream(MINIAPP_INDEX).pipe(res);
      return;
    }

    // Serve static miniapp assets: /miniapp/<file>
    if (url.startsWith("/miniapp") && method === "GET") {
      // map "/miniapp/anything" -> "./miniapp/anything"
      const rel = url.replace(/^\/miniapp\/?/, ""); // "" or "file.ext"
      const filePath = rel ? safeJoin(MINIAPP_DIR, rel) : MINIAPP_INDEX;

      if (!filePath) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Bad path.");
        return;
      }

      // If requesting folder-ish path, serve index.html
      const resolvedPath = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
        ? path.join(filePath, "index.html")
        : filePath;

      if (!fs.existsSync(resolvedPath)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not found.");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeFor(resolvedPath));
      fs.createReadStream(resolvedPath).pipe(res);
      return;
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
    console.log(`Mini app endpoint: /miniapp`);
  });

  return server;
}