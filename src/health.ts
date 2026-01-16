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

    // Health check endpoint for Render
    if (url === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
      return;
    }

    // Telegram webhook endpoint
    if (url === opts.webhookPath && method === "POST") {
      webhookCallback(req, res);
      return;
    }

    // Friendly root response
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