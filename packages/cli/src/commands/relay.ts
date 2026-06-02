import { startRelay } from "../relay-core.js";
import { writePidfile, removePidfile } from "../pidfile.js";
import { EXIT_USAGE } from "../exitcodes.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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
  const hmac = process.env["HMAC_SECRET"] ?? getArg(args, "--hmac");
  const home = getArg(args, "--home");

  const emit = (obj: Record<string, unknown>) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + "\n");
  };
  const human = (s: string) => { if (!jsonMode) console.error(`[relay] ${s}`); };

  const relay = await startRelay({
    port, db, hmac, useTunnel, emit, human,
    onShutdown: () => removePidfile(port, home),
  });

  writePidfile(port, {
    pid: process.pid,
    kind: "relay",
    tunnel_url: relay.tunnel?.wss,
    local_url: relay.localUrl,
    started_at: Date.now(),
  }, home);

  if (relay.tunnel) human(`share it:  agentroom invite create --server ${relay.tunnel.wss}`);

  process.on("SIGINT", () => relay.shutdown(0));
  process.on("SIGTERM", () => relay.shutdown(0));
  await new Promise(() => {}); // run until killed
}
