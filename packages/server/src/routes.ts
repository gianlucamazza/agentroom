import { IncomingMessage, ServerResponse } from "http";
import { issueChallenge } from "./auth.js";

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

export function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/auth/challenge") {
    const challenge = issueChallenge();
    return json(res, 200, { challenge });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  json(res, 404, { error: "not found" });
}
