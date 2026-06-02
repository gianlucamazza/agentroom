import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { loadOrCreateIdentity, identityPath, sessionsDir } from "@agentroom/sdk";
import { toBase64 } from "@agentroom/protocol";
import { detectCloudflared } from "../cloudflared.js";
import { EXIT_USAGE } from "../exitcodes.js";

export async function cmdSetup(args: string[]) {
  const jsonMode = args.includes("--json");
  const forceMode = args.includes("--force");
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

  const steps: Array<{ step: string; status: "created" | "ok" | "skipped" }> = [];

  // 2. .env — copy from .env.example and inject HMAC_SECRET if absent
  const envFile = path.resolve(cwd, ".env");
  const envExample = path.resolve(cwd, ".env.example");

  if (!existsSync(envFile)) {
    if (!existsSync(envExample)) {
      const msg = `.env.example not found at ${cwd}. Run this command from the agentroom repo root.`;
      if (jsonMode) console.log(JSON.stringify({ ready: false, error: msg }));
      else console.error(`error: ${msg}`);
      process.exit(EXIT_USAGE);
    }
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
  const dataDir = path.resolve(cwd, "data");
  mkdirSync(dataDir, { recursive: true });
  steps.push({ step: "data/", status: "ok" });

  // 4. Identity
  const idPath = identityPath(home);
  if (forceMode && existsSync(idPath)) {
    if (!jsonMode) console.warn(`warning: --force: removing existing identity at ${idPath}`);
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

  if (jsonMode) {
    console.log(JSON.stringify({ ready: true, pk, x25519_pk: x25519Pk, identity_path: idPath, env_path: envFile, data_dir: dataDir, cloudflared: cf, steps }));
    return;
  }

  for (const s of steps) {
    const icon = s.status === "created" ? "✓" : s.status === "ok" ? "✓" : "·";
    const label = s.status === "created" ? "created" : s.status === "skipped" ? "exists " : "ok     ";
    console.log(`  ${icon} ${s.step.padEnd(12)} ${label}`);
  }
  console.log();
  console.log(`  ed25519_pk: ${pk}`);
  console.log(`  x25519_pk:  ${x25519Pk}`);
  console.log();
  console.log("Ready. Next steps:");
  console.log("  npm run dev              # start relay server on :8787");
  console.log("  agentroom invite create  # create an invite for a peer");
}
