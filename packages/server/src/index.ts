// Suppress experimental SQLite warning (node:sqlite is stable enough for our use)
process.removeAllListeners("warning");

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { attachWss } from "./ws.js";
import { handleRequest } from "./routes.js";

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
attachWss(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[agentroom] listening on :${PORT}  (HTTP + WS on /ws)`);
});

process.on("SIGINT", () => {
  console.log("[agentroom] shutting down");
  httpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});
