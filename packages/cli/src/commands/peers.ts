import { AgentroomClient } from "@agentroom/sdk";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdPeers(args: string[]) {
  const server = getArg(args, "--server");
  if (!server) { console.error("--server <wss://host/ws> is required"); process.exit(1); }
  const home = getArg(args, "--home");

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });
  const peers = client.peers();
  client.disconnect();

  if (peers.length === 0) {
    console.log("No active sessions.");
  } else {
    for (const pk of peers) console.log(pk);
  }
}
