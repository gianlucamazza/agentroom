import { IncomingMessage, ServerResponse } from "http";
import { issueChallenge, consumeChallengeRate } from "./auth.js";
import { store } from "./store.js";
import { snapshot, inc } from "./metrics.js";

const startedAt = Date.now();

// TRUST_PROXY=true to read X-Forwarded-For (only if behind a trusted reverse proxy)
const TRUST_PROXY = process.env["TRUST_PROXY"] === "true";

function getIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

export function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/auth/challenge") {
    const ip = getIp(req);
    if (!consumeChallengeRate(ip)) {
      inc("rate_limit_hits");
      return json(res, 429, { error: "too many requests" });
    }
    inc("challenges_issued");
    const challenge = issueChallenge();
    return json(res, 200, { challenge });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    // Bug 2 fix: capture agents count once inside the try to avoid a second call outside
    let dbStatus = "ok";
    let agentsN = 0;
    try { agentsN = store.countAgents(); } catch { dbStatus = "error"; }
    return json(res, 200, {
      ok: dbStatus === "ok",
      db: dbStatus,
      agents: agentsN,
      pending: store.countAllPending(),
      invites: store.countInvites(),
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    return json(res, 200, snapshot());
  }

  json(res, 404, { error: "not found" });
}
