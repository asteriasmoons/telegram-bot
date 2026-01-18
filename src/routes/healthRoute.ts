// src/routes/healthRoute.ts
import http from "http";
import { sendText } from "../server/router";

export async function healthRoute(req: http.IncomingMessage, res: http.ServerResponse) {
  sendText(res, 200, "OK");
}