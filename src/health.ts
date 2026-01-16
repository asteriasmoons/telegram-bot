import http from "http";
import { Telegraf } from "telegraf";

type ServerOptions = {
  bot: Telegraf<any>;
  webhookPath: string; // e.g. "/telegram"
};

export function startServer(opts: ServerOptions) {
  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;

  const webhookCallback = opts.bot.webhookCallback(opts.webhookPath);

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    // Log every request so we can confirm Telegram is POSTing to the webhook path
    console.log(`[HTTP] ${method} ${url}`);

    if (url === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    if (url === opts.webhookPath && method === "POST") {
      webhookCallback(req, res);
      return;
    }

    // Helpful GET on the webhook path (so you can test it in a browser)
    if (url === opts.webhookPath && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Webhook endpoint is up. Telegram must POST here.");
      return;
    }

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