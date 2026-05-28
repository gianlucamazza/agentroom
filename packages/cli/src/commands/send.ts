import { AgentroomClient } from "@agentroom/sdk";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdSend(args: string[]) {
  // agentroom send <peer_pk> "<message>" --server wss://host/ws --home ./path
  const peerPk = args[0];
  const message = args[1];
  if (!peerPk || !message) {
    console.error("Usage: agentroom send <peer_pk> <message> --server <url>");
    process.exit(1);
  }

  const server = getArg(args, "--server");
  if (!server) { console.error("--server <wss://host/ws> is required"); process.exit(1); }
  const home = getArg(args, "--home");

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  try {
    await client.sendMessage(peerPk, message);
    console.log("✓ sent");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("No session")) {
      console.error(msg);
      console.error("\nTip: sessions are persisted per identity directory.");
      console.error("Make sure you have completed an invite handshake with this peer.");
    } else {
      console.error("[agentroom]", msg);
    }
    process.exitCode = 1;
  }

  client.disconnect();
}
