// Suppress experimental SQLite warning (node:sqlite is stable enough for our use)
process.removeAllListeners("warning");

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { attachWss, clearWssIntervals, getWss } from "./ws.js";
import { handleRequest } from "./routes.js";
import { store } from "./store.js";
import { clearChallengeInterval } from "./auth.js";
import { logEvent } from "./log.js";

// Load .env (never silently overwrite env vars already set by the host)
for (const envPath of [".env", "../../.env"].map((p) =>
  new URL(p, import.meta.url).pathname,
)) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
    break;
  }
}

// Fail fast — never start with insecure defaults
const REQUIRED_VARS = ["HMAC_SECRET"] as const;
const missing = REQUIRED_VARS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `[agentroom] Missing required env vars: ${missing.join(", ")}\n` +
    `Copy .env.example → .env and fill in the values.`,
  );
  process.exit(1);
}

const PORT = parseInt(process.env["PORT"] ?? "8787", 10);

const httpServer = createServer(handleRequest);
const wss = attachWss(httpServer);

httpServer.listen(PORT, () => {
  logEvent("info", "server.start", { port: PORT });
  logEvent("info", "server.config", { log_level: process.env["LOG_LEVEL"] ?? "info" });
});

async function gracefulShutdown(signal: string) {
  logEvent("info", "shutdown.start", { signal });

  // Stop accepting new HTTP connections
  httpServer.close();

  // Close all active WebSocket connections
  const wssInst = getWss() ?? wss;
  const closePromises = Array.from(wssInst.clients).map(
    (ws) => new Promise<void>((resolve) => {
      ws.on("close", resolve);
      ws.close(1001, "server shutting down");
    }),
  );

  // Wait for WS drain with 5s timeout
  await Promise.race([
    Promise.all(closePromises),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);

  // Cancel all timers
  clearWssIntervals();
  clearChallengeInterval();

  // Close the database
  try { store.closeDb(); } catch { /* ignore */ }

  logEvent("info", "shutdown.done", { signal });
  process.exit(0);
}

process.on("SIGINT",  () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
