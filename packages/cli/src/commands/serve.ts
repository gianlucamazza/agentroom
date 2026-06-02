import { AgentroomClient } from "@agentroom/sdk";
import { EXIT_NETWORK, EXIT_USAGE } from "../exitcodes.js";
import { wireServe } from "../serve-core.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * `agentroom serve` — keep one persistent connection open and auto-reply to
 * incoming messages by piping each through an external handler command. This is
 * the building block for autonomous multi-turn agent-to-agent conversations:
 * the handler is the "brain" (e.g. `claude -p`, `opencode run`, a script), the
 * CLI owns the single WS connection (so listen + send never race).
 */
export async function cmdServe(args: string[]) {
  const server = getArg(args, "--server");
  if (!server) { console.error("--server <wss://host/ws> is required"); process.exit(EXIT_USAGE); }
  const onMessage = getArg(args, "--on-message");
  if (!onMessage) {
    console.error('--on-message "<command>" is required (message piped to its stdin, stdout is the reply)');
    process.exit(EXIT_USAGE);
  }
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  const once = args.includes("--once");
  const maxTurns = Number(getArg(args, "--max-turns") ?? "0"); // 0 = unlimited
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    console.error("--max-turns must be a non-negative integer (0 = unlimited)");
    process.exit(EXIT_USAGE);
  }
  // Per-message handler timeout: a handler that never exits would otherwise stall
  // the serialized chain forever. Default 120s; --handler-timeout 0 disables it.
  const handlerTimeoutSec = Number(getArg(args, "--handler-timeout") ?? "120");
  if (!Number.isFinite(handlerTimeoutSec) || handlerTimeoutSec < 0) {
    console.error("--handler-timeout must be a non-negative number of seconds (0 = no timeout)");
    process.exit(EXIT_USAGE);
  }
  const handlerTimeoutMs = handlerTimeoutSec === 0 ? 2_147_483_647 : handlerTimeoutSec * 1000;
  const seed = getArg(args, "--seed");
  const seedTo = getArg(args, "--to");
  if (seed && !seedTo) { console.error("--seed requires --to <peer_pk>"); process.exit(EXIT_USAGE); }

  const client = new AgentroomClient();

  const emit = (obj: Record<string, unknown>) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + "\n");
  };
  const human = (s: string) => { if (!jsonMode) console.error(`[${new Date().toISOString()}] ${s}`); };

  const exit = (code = 0) => { client.disconnect(); process.exit(code); };

  const { sendSeed } = wireServe(client, {
    onMessage, handlerTimeoutMs, once, maxTurns, seed, seedTo, emit, human, exit,
  });

  await client.connect({ serverUrl: server, home, autoReconnect: true });

  emit({ type: "serving", pk: client.publicKey() });
  human("Serving: auto-replying via handler. Ctrl+C to stop.");

  // --invite: publish a fresh invite over THIS persistent connection (not a
  // separate `invite create` process), so the host keeps a single live
  // connection — no "replaced by new connection" churn. The invite embeds this
  // server's URL, so the remote peer can accept with just the invite.
  if (args.includes("--invite")) {
    try {
      const { url } = await client.createInvite();
      emit({ type: "invite", url });
      human(`invite (share out-of-band):\n${url}`);
    } catch (e) {
      emit({ type: "invite_error", error: e instanceof Error ? e.message : String(e) });
      human(`invite publish failed: ${e instanceof Error ? e.message : String(e)}`);
      exit(EXIT_NETWORK);
    }
  }

  await sendSeed();

  process.on("SIGINT", () => exit(0));
  process.on("SIGTERM", () => exit(0));

  await new Promise(() => {});
}
