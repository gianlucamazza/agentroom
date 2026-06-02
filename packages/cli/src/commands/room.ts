import { AgentroomClient } from "@agentroom/sdk";
import { startRelay } from "../relay-core.js";
import { wireServe } from "../serve-core.js";
import { writePidfile, removePidfile, readPidfiles, type RoomEntry } from "../pidfile.js";
import { EXIT_NETWORK, EXIT_USAGE } from "../exitcodes.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `agentroom room <open|stop|status>` (and alias `agentroom host` → open). */
export async function cmdRoom(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "open": return cmdRoomOpen(rest);
    case "stop": return cmdRoomStop(rest);
    case "status": return cmdRoomStatus(rest);
    default:
      console.error("Usage: agentroom room <open|stop|status>");
      process.exit(EXIT_USAGE);
  }
}

/**
 * `agentroom room open` (alias `agentroom host`) — open a tunneled room in ONE
 * process: start the relay + public tunnel, connect the host's own client
 * locally (ws://localhost), publish an invite embedding the PUBLIC tunnel URL,
 * and auto-reply via the handler. Prints both the tunnel and the invite on the
 * same stream — no second process, no log-scraping, one host connection (no
 * "replaced by new connection" churn).
 */
export async function cmdRoomOpen(args: string[]) {
  const onMessage = getArg(args, "--on-message");
  if (!onMessage) {
    console.error('--on-message "<command>" is required (message piped to its stdin, stdout is the reply)');
    process.exit(EXIT_USAGE);
  }
  const port = Number(getArg(args, "--port") ?? process.env["PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be a valid TCP port");
    process.exit(EXIT_USAGE);
  }
  const db = getArg(args, "--db");
  const hmac = process.env["HMAC_SECRET"] ?? getArg(args, "--hmac");
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  const useTunnel = !args.includes("--no-tunnel");
  const once = args.includes("--once");
  const maxTurns = Number(getArg(args, "--max-turns") ?? "0");
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    console.error("--max-turns must be a non-negative integer (0 = unlimited)");
    process.exit(EXIT_USAGE);
  }
  const handlerTimeoutSec = Number(getArg(args, "--handler-timeout") ?? "120");
  if (!Number.isFinite(handlerTimeoutSec) || handlerTimeoutSec < 0) {
    console.error("--handler-timeout must be a non-negative number of seconds (0 = no timeout)");
    process.exit(EXIT_USAGE);
  }
  const handlerTimeoutMs = handlerTimeoutSec === 0 ? 2_147_483_647 : handlerTimeoutSec * 1000;
  const seed = getArg(args, "--seed");
  const seedTo = getArg(args, "--to");
  if (seed && !seedTo) { console.error("--seed requires --to <peer_pk>"); process.exit(EXIT_USAGE); }

  const emit = (obj: Record<string, unknown>) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + "\n");
  };
  const human = (s: string) => { if (!jsonMode) console.error(`[room] ${s}`); };

  let client: AgentroomClient | undefined;
  const relay = await startRelay({
    port, db, hmac, useTunnel, emit, human,
    onShutdown: () => { client?.disconnect(); removePidfile(port, home); },
  });

  // The host connects to its OWN relay locally; the invite carries the public
  // tunnel URL so the remote peer reaches the same server through the tunnel.
  const inviteServerUrl = relay.tunnel?.wss ?? relay.localUrl;

  client = new AgentroomClient();
  const exit = (code = 0) => relay.shutdown(code); // runs onShutdown (disconnect + pidfile), then stops children
  const { sendSeed } = wireServe(client, {
    onMessage, handlerTimeoutMs, once, maxTurns, seed, seedTo, emit, human, exit,
  });

  await client.connect({ serverUrl: relay.localUrl, home, autoReconnect: true });
  emit({ type: "serving", pk: client.publicKey() });
  human("Serving: auto-replying via handler. Ctrl+C to stop.");

  try {
    const { url } = await client.createInvite(inviteServerUrl);
    emit({ type: "invite", url });
    human(`invite (share out-of-band):\n${url}`);
  } catch (e) {
    emit({ type: "invite_error", error: e instanceof Error ? e.message : String(e) });
    human(`invite publish failed: ${e instanceof Error ? e.message : String(e)}`);
    exit(EXIT_NETWORK);
  }

  writePidfile(port, {
    pid: process.pid,
    kind: "room",
    tunnel_url: relay.tunnel?.wss,
    local_url: relay.localUrl,
    started_at: Date.now(),
  }, home);

  await sendSeed();

  process.on("SIGINT", () => relay.shutdown(0));
  process.on("SIGTERM", () => relay.shutdown(0));
  await new Promise(() => {}); // run until killed
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** `agentroom room status` — list live rooms from pidfiles (pruning stale). */
export async function cmdRoomStatus(args: string[]) {
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  const rooms = readPidfiles(home, true);

  if (jsonMode) {
    console.log(JSON.stringify({ rooms: rooms.map((r) => ({ ...r, uptime_s: Math.floor((Date.now() - r.started_at) / 1000) })) }));
    return;
  }
  if (rooms.length === 0) { console.log("No rooms running."); return; }
  for (const r of rooms) {
    console.log(`  port ${r.port}  pid ${r.pid}  ${r.kind.padEnd(5)}  up ${fmtUptime(Date.now() - r.started_at)}`);
    console.log(`    ${r.tunnel_url ?? r.local_url}`);
  }
}

/**
 * `agentroom room stop [--port <n>] [--all]` — SIGTERM the room process(es) by
 * pid (never `pkill -f`, which would match and kill this very command). With no
 * selector and a single room running, stops that one.
 */
export async function cmdRoomStop(args: string[]) {
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  const all = args.includes("--all");
  const portArg = getArg(args, "--port");
  const rooms = readPidfiles(home, true).filter((r) => r.alive);

  let targets: RoomEntry[];
  if (all) {
    targets = rooms;
  } else if (portArg) {
    const port = Number(portArg);
    targets = rooms.filter((r) => r.port === port);
    if (targets.length === 0) {
      console.error(`No running room on port ${port}`);
      process.exit(EXIT_USAGE);
    }
  } else if (rooms.length === 1) {
    targets = rooms;
  } else if (rooms.length === 0) {
    if (jsonMode) console.log(JSON.stringify({ stopped: [] }));
    else console.log("No rooms running.");
    return;
  } else {
    console.error(`${rooms.length} rooms running — pass --port <n> or --all`);
    process.exit(EXIT_USAGE);
  }

  const stopped: number[] = [];
  for (const r of targets) {
    try { process.kill(r.pid, "SIGTERM"); } catch { /* already gone */ }
    removePidfile(r.port, home); // the process also removes it on graceful exit
    stopped.push(r.port);
  }
  if (jsonMode) console.log(JSON.stringify({ stopped }));
  else console.log(`Stopped room(s) on port: ${stopped.join(", ")}`);
}
