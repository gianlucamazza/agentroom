import { AgentroomClient } from "@agentroom/sdk";
import { EXIT_USAGE, EXIT_NETWORK, EXIT_NO_SESSION } from "../exitcodes.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdSend(args: string[]) {
  // agentroom send <peer_pk> "<message>" --server wss://host/ws [--home] [--json]
  const peerPk = args[0];
  const message = args[1];

  if (!peerPk || !message) {
    console.error("Usage: agentroom send <peer_pk> <message> --server <url>");
    process.exit(EXIT_USAGE);
  }

  // B12: catch accidental flag as message (e.g. send pk --server ...)
  if (message.startsWith("--")) {
    console.error(`Usage: agentroom send <peer_pk> "<message>" --server <url>`);
    console.error(`Hint: wrap the message in quotes if it contains spaces or special chars.`);
    process.exit(EXIT_USAGE);
  }

  const server = getArg(args, "--server");
  if (!server) {
    console.error("--server <wss://host/ws> is required");
    process.exit(EXIT_USAGE);
  }
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");

  const client = new AgentroomClient();

  try {
    await client.connect({ serverUrl: server, home });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error("[agentroom] connection failed:", msg);
    }
    process.exit(EXIT_NETWORK);
  }

  try {
    await client.sendMessage(peerPk, message);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true }));
    } else {
      console.log("✓ sent");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else if (msg.includes("No session")) {
      console.error(msg);
      console.error("\nTip: sessions are persisted per identity directory.");
      console.error("Make sure you have completed an invite handshake with this peer.");
    } else {
      console.error("[agentroom]", msg);
    }
    const isNoSession = msg.includes("No session");
    const isTimeout = msg.includes("timeout") || msg.includes("ACK timeout");
    process.exitCode = isNoSession ? EXIT_NO_SESSION : isTimeout ? EXIT_NETWORK : 1;
  }

  client.disconnect();
}
