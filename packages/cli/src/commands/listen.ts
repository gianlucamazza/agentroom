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

  const client = new AgentroomClient();

  client.onMessage((from, text) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ type: "message", from, text, ts: Date.now() }) + "\n");
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

  await client.connect({ serverUrl: server, home, autoReconnect: true });

  if (!jsonMode) console.log("Listening for messages. Ctrl+C to stop.");

  process.on("SIGINT", () => {
    client.disconnect();
    process.exit(0);
  });

  // keep alive
  await new Promise(() => {});
}
