import { spawn, fork, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { ensureCloudflared } from "./cloudflared.js";
import { EXIT_ERROR, EXIT_NETWORK } from "./exitcodes.js";

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

export interface StartRelayOpts {
  port: number;
  db?: string | undefined;
  /** Pinned HMAC_SECRET; if absent, env HMAC_SECRET wins, else one is generated. */
  hmac?: string | undefined;
  useTunnel: boolean;
  emit: (obj: Record<string, unknown>) => void;
  human: (s: string) => void;
  /** Invoked once at the start of shutdown, before children are killed. */
  onShutdown?: (() => void) | undefined;
}

export interface RelayHandle {
  port: number;
  base: string; // http://localhost:PORT
  localUrl: string; // ws://localhost:PORT/ws
  tunnel?: { wss: string; https: string; reachable: boolean };
  hmac: string;
  hmacGenerated: boolean;
  shutdown: (code?: number) => void;
}

/**
 * Start the bundled relay server (and, with useTunnel, a cloudflared quick
 * tunnel) and resolve once it is healthy / the tunnel URL is known. Shared by
 * `agentroom relay` and `agentroom room open`. On a fatal startup error it
 * shuts down and exits the process (so the returned promise never resolves) —
 * matching the original `cmdRelay` behavior.
 */
export async function startRelay(opts: StartRelayOpts): Promise<RelayHandle> {
  const { port, db, useTunnel, emit, human } = opts;

  // HMAC_SECRET: explicit/env wins; otherwise generate an ephemeral one and
  // surface it once so the peer running the relay can pin it (via .env) and
  // reuse the same secret across restarts.
  let hmac = opts.hmac ?? process.env["HMAC_SECRET"];
  let hmacGenerated = false;
  if (!hmac) {
    hmac = randomBytes(24).toString("hex"); // 48 hex chars (> 32 required)
    hmacGenerated = true;
  }

  let cf: ChildProcess | undefined;
  let srv: ChildProcess | undefined;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.onShutdown?.();

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
    if (pending.size === 0) {
      process.exit(code);
      return;
    }

    for (const child of pending) child.kill("SIGTERM");
    const force = setTimeout(() => {
      for (const child of pending) child.kill("SIGKILL");
      process.exit(code);
    }, 6000);
    force.unref?.();
  };

  // ── Start the server ──────────────────────────────────────────────────────
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HMAC_SECRET: hmac,
    PORT: String(port),
  };
  if (db) env["AGENTROOM_DB"] = db;
  // Re-fork this same executable with the internal `__relay-server` command so
  // the bundled single-file CLI runs a relay with no separate @agentroom/server
  // to resolve. The server's NDJSON logs go to stderr to keep our stdout clean.
  const selfEntry = process.argv[1];
  if (!selfEntry) {
    console.error("cannot determine CLI entry to launch the relay server");
    process.exit(EXIT_ERROR);
  }
  srv = fork(selfEntry, ["__relay-server"], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  srv.stdout?.pipe(process.stderr);
  srv.stderr?.pipe(process.stderr);
  srv.on("exit", (code) => {
    if (!shuttingDown) {
      emit({ type: "server_exit", code });
      human(`server exited (${code}) — port ${port} in use or misconfigured`);
      shutdown(EXIT_NETWORK);
    }
  });

  const base = `http://localhost:${port}`;
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  if (!healthy) {
    human("server did not become healthy in time");
    shutdown(EXIT_NETWORK);
    await sleep(60_000); // shutdown() will process.exit; never resolve
  }

  if (hmacGenerated) {
    emit({ type: "hmac_generated", hmac_secret: hmac });
    human(
      `generated ephemeral HMAC_SECRET (pin it in .env to reuse it across restarts): ${hmac}`,
    );
  }
  emit({ type: "listening", port, local_url: `ws://localhost:${port}/ws` });
  human(
    `relay listening on ws://localhost:${port}/ws  (health: ${base}/health)`,
  );

  const handle: RelayHandle = {
    port,
    base,
    localUrl: `ws://localhost:${port}/ws`,
    hmac,
    hmacGenerated,
    shutdown,
  };

  // ── Optional: public quick tunnel ────────────────────────────────────────
  if (useTunnel) {
    human("opening cloudflared quick tunnel (no account/domain needed)…");
    let cfBin: string;
    try {
      const cfInfo = await ensureCloudflared({ emit, human });
      cfBin = cfInfo.path;
    } catch (e) {
      const msg = `cloudflared unavailable: ${String((e as Error).message ?? e)}`;
      emit({ type: "tunnel_error", error: msg });
      human(msg);
      shutdown(EXIT_ERROR);
      await sleep(60_000);
    }

    cf = spawn(cfBin!, ["tunnel", "--url", base, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cf.on("error", (e) => {
      const msg =
        (e as NodeJS.ErrnoException).code === "ENOENT"
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
      if (/Registered tunnel connection|Connection .* registered/i.test(s))
        registered = true;
    };
    cf.stdout?.on("data", onLog);
    cf.stderr?.on("data", onLog);

    for (let i = 0; i < 120 && (!url || !registered); i++) await sleep(500);
    if (!url) {
      human("cloudflared did not produce a tunnel URL in time");
      shutdown(EXIT_NETWORK);
      await sleep(60_000);
    }

    const wss = url.replace(/^https:/, "wss:") + "/ws";
    const httpsHost = url;

    let reachable = false;
    for (let i = 0; i < 50; i++) {
      await flushDns();
      try {
        const r = await fetch(`${httpsHost}/health`);
        if (r.ok) {
          reachable = true;
          break;
        }
      } catch {
        /* propagating */
      }
      await sleep(500);
    }

    emit({ type: "tunnel", url: wss, https: httpsHost, reachable });
    human(
      reachable
        ? `public relay ready:  ${wss}`
        : `tunnel URL (not yet confirmed reachable, give DNS a few s):  ${wss}`,
    );
    handle.tunnel = { wss, https: httpsHost, reachable };
  }

  return handle;
}
