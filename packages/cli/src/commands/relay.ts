import { spawn, fork, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { ensureCloudflared } from "../cloudflared.js";
import { EXIT_ERROR, EXIT_NETWORK, EXIT_USAGE } from "../exitcodes.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Best-effort, Linux/systemd-only: a fresh *.trycloudflare.com hostname takes a
// few seconds to go live; a too-early lookup gets a negative answer that
// systemd-resolved caches and keeps serving past the record going live. Flushing
// between probes clears that. No-op (silently) on macOS/other resolvers.
function flushDns(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("resolvectl", ["flush-caches"], { stdio: "ignore" });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
  });
}

/**
 * `agentroom relay` — run a relay anywhere, portably. Starts the bundled server
 * as a child process and, with `--tunnel`, opens a cloudflared quick tunnel
 * (no Cloudflare account/domain needed) and prints the public `wss://…/ws` URL
 * ready to paste into `agentroom invite create --server`. This is what makes the
 * all-in-one skill self-contained: one binary is both client and relay.
 */
export async function cmdRelay(args: string[]) {
  const port = Number(getArg(args, "--port") ?? process.env["PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be a valid TCP port");
    process.exit(EXIT_USAGE);
  }
  const useTunnel = args.includes("--tunnel");
  const jsonMode = args.includes("--json");
  const db = getArg(args, "--db");

  // HMAC_SECRET: env/.env wins; otherwise generate an ephemeral one and surface
  // it once so the operator can pin it (via .env) for a stable relay identity.
  let hmac = process.env["HMAC_SECRET"] ?? getArg(args, "--hmac");
  let hmacGenerated = false;
  if (!hmac) {
    hmac = randomBytes(24).toString("hex"); // 48 hex chars (> 32 required)
    hmacGenerated = true;
  }

  const emit = (obj: Record<string, unknown>) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + "\n");
  };
  const human = (s: string) => { if (!jsonMode) console.error(`[relay] ${s}`); };

  let cf: ChildProcess | undefined;
  let srv: ChildProcess | undefined;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Wait for the children to actually exit before leaving: the server drains
    // its WebSocket connections for up to 5s on SIGTERM, and a fixed 300ms exit
    // cut that short (clients got connection-reset instead of a graceful close).
    const pending = new Set<ChildProcess>();
    for (const child of [srv, cf]) {
      if (child && child.exitCode === null && !child.killed) {
        pending.add(child);
        child.once("exit", () => {
          pending.delete(child);
          if (pending.size === 0) process.exit(code);
        });
      }
    }
    if (pending.size === 0) { process.exit(code); return; }

    for (const child of pending) child.kill("SIGTERM");
    // Fallback: force-kill anything still alive past the server's drain window.
    const force = setTimeout(() => {
      for (const child of pending) child.kill("SIGKILL");
      process.exit(code);
    }, 6000);
    force.unref?.();
  };

  // ── Start the server ──────────────────────────────────────────────────────
  const env: NodeJS.ProcessEnv = { ...process.env, HMAC_SECRET: hmac, PORT: String(port) };
  if (db) env["AGENTROOM_DB"] = db;
  // Host the server in-process by re-forking this same executable with the
  // internal `__relay-server` command. Works both in dev (entry = cli dist) and
  // in the bundled single-file CLI (no separate @agentroom/server to resolve).
  // Keep our own stdout clean (it carries our JSON events); route the server's
  // NDJSON logs to stderr so they don't corrupt the event stream.
  const selfEntry = process.argv[1];
  if (!selfEntry) { console.error("cannot determine CLI entry to launch the relay server"); process.exit(EXIT_ERROR); }
  srv = fork(selfEntry, ["__relay-server"], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  srv.stdout?.pipe(process.stderr);
  srv.stderr?.pipe(process.stderr);
  srv.on("exit", (code) => {
    if (!shuttingDown) {
      emit({ type: "server_exit", code });
      human(`server exited (${code}) — port ${port} in use or misconfigured`);
      shutdown(EXIT_NETWORK);
    }
  });

  // Wait until the server answers /health.
  const base = `http://localhost:${port}`;
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { healthy = true; break; }
    } catch { /* not up yet */ }
  }
  if (!healthy) {
    human("server did not become healthy in time");
    shutdown(EXIT_NETWORK);
    return;
  }

  if (hmacGenerated) {
    emit({ type: "hmac_generated", hmac_secret: hmac });
    human(`generated ephemeral HMAC_SECRET (pin it in .env for a stable relay): ${hmac}`);
  }
  emit({ type: "listening", port, local_url: `ws://localhost:${port}/ws` });
  human(`relay listening on ws://localhost:${port}/ws  (health: ${base}/health)`);

  // ── Optional: public quick tunnel ────────────────────────────────────────
  if (useTunnel) {
    human("opening cloudflared quick tunnel (no account/domain needed)…");

    // agentroom manages cloudflared itself: pinned version, sha256-verified,
    // cached under ~/.config/agentroom/bin — no system install required.
    let cfBin: string;
    try {
      const cfInfo = await ensureCloudflared({ emit, human });
      cfBin = cfInfo.path;
    } catch (e) {
      const msg = `cloudflared unavailable: ${String((e as Error).message ?? e)}`;
      emit({ type: "tunnel_error", error: msg });
      human(msg);
      shutdown(EXIT_ERROR);
      return;
    }

    cf = spawn(cfBin, ["tunnel", "--url", base, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cf.on("error", (e) => {
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT"
        ? `cloudflared binary not runnable at ${cfBin}`
        : String(e);
      emit({ type: "tunnel_error", error: msg });
      human(msg);
      shutdown(EXIT_ERROR);
    });

    let url = "";
    let registered = false;
    const onLog = (buf: Buffer) => {
      const s = buf.toString();
      process.stderr.write(s);
      if (!url) {
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) url = m[0];
      }
      if (/Registered tunnel connection|Connection .* registered/i.test(s)) registered = true;
    };
    cf.stdout?.on("data", onLog);
    cf.stderr?.on("data", onLog);

    // Wait for the URL and edge registration. We deliberately do NOT probe the
    // hostname before registration: a too-early lookup gets a negative DNS answer
    // that some resolvers (systemd-resolved) cache and keep serving. See notes.
    for (let i = 0; i < 120 && (!url || !registered); i++) await sleep(500);
    if (!url) {
      human("cloudflared did not produce a tunnel URL in time");
      shutdown(EXIT_NETWORK);
      return;
    }

    const wss = url.replace(/^https:/, "wss:") + "/ws";
    const httpsHost = url;

    // Confirm reachability through the tunnel before announcing, flushing the DNS
    // negative-cache between tries (see flushDns). This also warms the resolver so
    // a separate client process (e.g. `invite create`) resolves the host too.
    let reachable = false;
    for (let i = 0; i < 50; i++) {
      await flushDns();
      try {
        const r = await fetch(`${httpsHost}/health`);
        if (r.ok) { reachable = true; break; }
      } catch { /* propagating */ }
      await sleep(500);
    }

    emit({ type: "tunnel", url: wss, https: httpsHost, reachable });
    human(reachable
      ? `public relay ready:  ${wss}`
      : `tunnel URL (not yet confirmed reachable, give DNS a few s):  ${wss}`);
    human(`share it:  agentroom invite create --server ${wss}`);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await new Promise(() => {}); // run until killed
}
