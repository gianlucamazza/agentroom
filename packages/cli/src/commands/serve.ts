import { AgentroomClient } from "@agentroom/sdk";
import { EXIT_NETWORK, EXIT_USAGE } from "../exitcodes.js";
import { runHandler } from "../handler.js";

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
  // Optional opening message sent right after connect, on the same connection,
  // so a bot can *start* a conversation without a second process (a separate
  // `send` would open a duplicate connection for the same identity, and the
  // server closes the older one — see server ws HELLO handling).
  const seed = getArg(args, "--seed");
  const seedTo = getArg(args, "--to");
  if (seed && !seedTo) { console.error("--seed requires --to <peer_pk>"); process.exit(EXIT_USAGE); }

  const client = new AgentroomClient();

  const emit = (obj: Record<string, unknown>) => {
    if (jsonMode) process.stdout.write(JSON.stringify({ ...obj, ts: Date.now() }) + "\n");
  };
  const human = (s: string) => { if (!jsonMode) console.error(`[${new Date().toISOString()}] ${s}`); };

  let replies = 0;
  // Serialize handler runs so concurrent inbound messages don't interleave
  // ratchet state on the same session.
  let chain: Promise<void> = Promise.resolve();

  function shutdown(code = 0) {
    client.disconnect();
    process.exit(code);
  }

  client.onMessage((from, text) => {
    chain = chain.then(async () => {
      emit({ type: "received", from, text });
      human(`recv ${from.slice(0, 12)}…  ${text}`);

      const { reply, code, stderr } = await runHandler(onMessage, text, { from, pk: client.publicKey() }, handlerTimeoutMs);
      if (code !== 0) {
        emit({ type: "handler_error", from, code, stderr: stderr.slice(0, 500) });
        human(`handler exited ${code} — no reply sent. ${stderr.slice(0, 200)}`);
        return;
      }
      if (!reply) {
        emit({ type: "no_reply", from });
        human(`handler produced empty reply — nothing sent`);
        return;
      }

      try {
        await client.sendMessage(from, reply);
        replies++;
        emit({ type: "replied", to: from, text: reply, turn: replies });
        human(`sent ${from.slice(0, 12)}…  ${reply}`);
      } catch (e) {
        emit({ type: "send_error", to: from, error: e instanceof Error ? e.message : String(e) });
        human(`send failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      if (once || (maxTurns > 0 && replies >= maxTurns)) {
        emit({ type: "done", replies });
        human(`reached ${once ? "--once" : `--max-turns ${maxTurns}`} — exiting`);
        shutdown(0);
      }
    }).catch((e) => {
      emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
    });
  });

  client.onPeerOnline((pk) => emit({ type: "peer_online", pk }));
  client.onDisconnect((reason) => { emit({ type: "disconnect", reason }); human(`disconnected (${reason}) — reconnecting…`); });
  client.onReconnect(() => { emit({ type: "reconnect" }); human("reconnected"); });
  client.onReconnectFailed((reason) => {
    emit({ type: "reconnect_failed", reason });
    human(`reconnect failed: ${reason}`);
    shutdown(EXIT_NETWORK);
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
      shutdown(EXIT_NETWORK);
    }
  }

  if (seed && seedTo) {
    try {
      await client.sendMessage(seedTo, seed);
      replies++;
      emit({ type: "replied", to: seedTo, text: seed, turn: replies, seed: true });
      human(`seed ${seedTo.slice(0, 12)}…  ${seed}`);
    } catch (e) {
      emit({ type: "send_error", to: seedTo, error: e instanceof Error ? e.message : String(e) });
      human(`seed send failed: ${e instanceof Error ? e.message : String(e)}`);
      shutdown(EXIT_NETWORK);
    }
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  await new Promise(() => {});
}
