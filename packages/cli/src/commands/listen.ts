import { AgentroomClient } from "@agentroom/sdk";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdListen(args: string[]) {
  const server = getArg(args, "--server");
  if (!server) { console.error("--server <wss://host/ws> is required"); process.exit(1); }
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  const quietMode = args.includes("--quiet");

  const client = new AgentroomClient();

  client.onMessage((from, text) => {
    if (jsonMode) {
      const out: Record<string, unknown> = { type: "message", from, ts: Date.now() };
      if (!quietMode) out["text"] = text;
      else out["size"] = new TextEncoder().encode(text).length;
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (quietMode) {
      console.log(`[${new Date().toISOString()}] ${from.slice(0, 12)}… (${new TextEncoder().encode(text).length}B)`);
    } else {
      console.log(`[${new Date().toISOString()}] ${from.slice(0, 12)}…  ${text}`);
    }
  });

  client.onPeerOnline((pk) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ type: "peer_online", pk, ts: Date.now() }) + "\n");
    } else {
      console.log(`[${new Date().toISOString()}] peer online: ${pk.slice(0, 12)}…`);
    }
  });

  client.onDisconnect((reason) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ type: "disconnect", reason, ts: Date.now() }) + "\n");
    } else {
      console.error(`[${new Date().toISOString()}] disconnected (${reason}) — reconnecting…`);
    }
  });

  client.onReconnect(() => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ type: "reconnect", ts: Date.now() }) + "\n");
    } else {
      console.error(`[${new Date().toISOString()}] reconnected`);
    }
  });

  client.onReconnectFailed((reason) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ type: "reconnect_failed", reason, ts: Date.now() }) + "\n");
    } else {
      console.error(`[${new Date().toISOString()}] reconnect failed: ${reason}`);
    }
    process.exit(1);
  });

  await client.connect({ serverUrl: server, home, autoReconnect: true });

  if (!jsonMode) console.log("Listening for messages. Ctrl+C to stop.");

  function shutdown() {
    client.disconnect();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // keep alive
  await new Promise(() => {});
}
