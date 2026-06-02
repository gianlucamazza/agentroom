import type { AgentroomClient } from "@agentroom/sdk";
import { EXIT_NETWORK } from "./exitcodes.js";
import { runHandler } from "./handler.js";

export interface ServeOpts {
  onMessage: string;
  handlerTimeoutMs: number;
  once: boolean;
  maxTurns: number; // 0 = unlimited
  seed?: string | undefined;
  seedTo?: string | undefined;
  emit: (obj: Record<string, unknown>) => void;
  human: (s: string) => void;
  /** Tear down + exit. Lets the caller decide how (disconnect, stop relay…). */
  exit: (code: number) => void;
}

/**
 * Wire auto-reply on an already-connected client: every inbound message is piped
 * to the handler command and its stdout sent back, serialized so concurrent
 * messages don't interleave ratchet state. Shared by `serve` and `room open`.
 * Returns `sendSeed()` to optionally open the conversation on the same
 * connection (a separate `send` would race the same identity's connection).
 */
export function wireServe(client: AgentroomClient, opts: ServeOpts): { sendSeed: () => Promise<void> } {
  const { onMessage, handlerTimeoutMs, once, maxTurns, seed, seedTo, emit, human, exit } = opts;
  let replies = 0;
  let chain: Promise<void> = Promise.resolve();

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
        exit(0);
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
    exit(EXIT_NETWORK);
  });

  async function sendSeed() {
    if (!seed || !seedTo) return;
    try {
      await client.sendMessage(seedTo, seed);
      replies++;
      emit({ type: "replied", to: seedTo, text: seed, turn: replies, seed: true });
      human(`seed ${seedTo.slice(0, 12)}…  ${seed}`);
    } catch (e) {
      emit({ type: "send_error", to: seedTo, error: e instanceof Error ? e.message : String(e) });
      human(`seed send failed: ${e instanceof Error ? e.message : String(e)}`);
      exit(EXIT_NETWORK);
    }
  }

  return { sendSeed };
}
