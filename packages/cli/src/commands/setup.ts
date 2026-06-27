import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  rmSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import {
  loadOrCreateIdentity,
  identityPath,
  sessionsDir,
  configBase,
} from "@agentroom/sdk";
import { toBase64 } from "@agentroom/protocol";
import { detectCloudflared } from "../cloudflared.js";
import { EXIT_USAGE } from "../exitcodes.js";

// wss://host/ws -> https://host/health ; ws://host:port/ws -> http://host:port/health
function healthUrl(serverUrl: string): string {
  return (
    serverUrl.replace(/^ws/, "http").replace(/\/ws$/, "").replace(/\/$/, "") +
    "/health"
  );
}

export async function cmdSetup(args: string[]) {
  const jsonMode = args.includes("--json");
  const forceMode = args.includes("--force");
  const noProbe = args.includes("--no-probe");
  const cwdIdx = args.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? (args[cwdIdx + 1] ?? process.cwd()) : process.cwd();
  const homeIdx = args.indexOf("--home");
  // Single identity: only the explicit --home dev/test flag selects an alternate
  // dir; otherwise the default config home is used (no env override).
  const home = homeIdx >= 0 ? args[homeIdx + 1] : undefined;

  // 1. Check Node >= 22
  const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor < 22) {
    const msg = `Node >= 22 required for node:sqlite (found ${nodeMajor})`;
    if (jsonMode) console.log(JSON.stringify({ ready: false, error: msg }));
    else console.error(`error: ${msg}`);
    process.exit(EXIT_USAGE);
  }

  const steps: Array<{ step: string; status: "created" | "ok" | "skipped" }> =
    [];

  // 2. .env + data/ — from-source scaffolding for hosting a relay out of the repo.
  // Only when run from the repo root (.env.example present); the plugin/global CLI
  // runs in the user's cwd and needs none of this (room/relay generate HMAC_SECRET
  // on their own), so we skip it instead of failing.
  const envFile = path.resolve(cwd, ".env");
  const envExample = path.resolve(cwd, ".env.example");
  const inRepo = existsSync(envFile) || existsSync(envExample);
  let dataDir: string | undefined;

  if (inRepo) {
    if (!existsSync(envFile)) {
      const secret = randomBytes(32).toString("hex");
      const content = readFileSync(envExample, "utf8").replace(
        /^HMAC_SECRET=.*$/m,
        `HMAC_SECRET=${secret}`,
      );
      writeFileSync(envFile, content, { encoding: "utf8" });
      chmodSync(envFile, 0o600);
      steps.push({ step: "env", status: "created" });
    } else {
      steps.push({ step: "env", status: "skipped" });
    }
    // 3. data/ directory
    dataDir = path.resolve(cwd, "data");
    mkdirSync(dataDir, { recursive: true });
    steps.push({ step: "data/", status: "ok" });
  } else {
    steps.push({ step: "env", status: "skipped" });
  }

  // 4. Identity
  const idPath = identityPath(home);
  if (forceMode && existsSync(idPath)) {
    if (!jsonMode)
      console.warn(`warning: --force: removing existing identity at ${idPath}`);
    unlinkSync(idPath);
    // Sessions are ratchet states tied to the discarded identity's keys — they
    // can't decrypt anything under the new key, so drop them for a clean rotation.
    rmSync(sessionsDir(home), { recursive: true, force: true });
  }
  const isNew = !existsSync(idPath);
  const identity = await loadOrCreateIdentity(home);
  const pk = toBase64(identity.ed25519_pk);
  const x25519Pk = toBase64(identity.x25519_pk);
  steps.push({ step: "identity", status: isNew ? "created" : "skipped" });

  // cloudflared is auto-managed (downloaded on first `relay --tunnel`); report
  // what's already available without forcing a download.
  const cf = detectCloudflared(home);

  // Persisted relay URL (written once a relay/room is up). Empty when none yet —
  // callers branch on this to decide whether to provision a relay. With a URL and
  // unless --no-probe, do a best-effort /health check (never fails setup).
  const serverUrlFile = path.join(configBase(home), "server_url");
  const serverUrl = existsSync(serverUrlFile)
    ? readFileSync(serverUrlFile, "utf8").trim()
    : "";
  let reachable: boolean | undefined;
  if (serverUrl && !noProbe) {
    try {
      const r = await fetch(healthUrl(serverUrl), {
        signal: AbortSignal.timeout(3000),
      });
      reachable = r.ok;
    } catch {
      reachable = false;
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify({
        ready: true,
        pk,
        x25519_pk: x25519Pk,
        identity_path: idPath,
        env_path: inRepo ? envFile : undefined,
        data_dir: dataDir,
        cloudflared: cf,
        server_url: serverUrl,
        ...(reachable !== undefined ? { reachable } : {}),
        steps,
      }),
    );
    return;
  }

  for (const s of steps) {
    const icon = s.status === "created" ? "✓" : s.status === "ok" ? "✓" : "·";
    const label =
      s.status === "created"
        ? "created"
        : s.status === "skipped"
          ? "exists "
          : "ok     ";
    console.log(`  ${icon} ${s.step.padEnd(12)} ${label}`);
  }
  console.log();
  console.log(`  ed25519_pk: ${pk}`);
  console.log(`  x25519_pk:  ${x25519Pk}`);
  if (serverUrl) {
    console.log(
      `  server_url: ${serverUrl}${reachable === undefined ? "" : reachable ? " (reachable)" : " (unreachable)"}`,
    );
  }
  console.log();
  console.log("Ready. Next steps:");
  if (serverUrl) {
    console.log("  agentroom invite create  # create an invite for a peer");
  } else {
    console.log(
      "  agentroom room open --on-message '<cmd>'  # relay + tunnel + invite, one command",
    );
  }
}
