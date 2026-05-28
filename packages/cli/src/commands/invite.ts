import { AgentroomClient } from "@agentroom/sdk";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireArg(args: string[], flag: string, name: string): string {
  const v = getArg(args, flag);
  if (!v) { console.error(`Missing ${flag} <${name}>`); process.exit(1); }
  return v;
}

export async function cmdInviteCreate(args: string[]) {
  const server = requireArg(args, "--server", "wss://host/ws");
  const home = getArg(args, "--home");

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  const { url } = await client.createInvite();
  console.log("\nInvite URL (share out-of-band):\n");
  console.log(url);
  console.log("\nExpires in 24 hours. Single use.");

  client.disconnect();
}

export async function cmdInviteAccept(args: string[]) {
  // agentroom invite accept '<url>' --server wss://host/ws --home ./path
  const urlArg = args[0];
  if (!urlArg || !urlArg.startsWith("agentroom://")) {
    console.error("Usage: agentroom invite accept '<agentroom://invite/...>' --server <url>");
    process.exit(1);
  }
  const server = requireArg(args, "--server", "wss://host/ws");
  const home = getArg(args, "--home");

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  const peerPk = await client.acceptInvite(urlArg);
  console.log("✓ Session established with peer:");
  console.log(peerPk);

  client.disconnect();
}
