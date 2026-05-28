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
  // agentroom invite accept '<url>' --server wss://host/ws --home ./path --wait 10
  const urlArg = args[0];
  if (!urlArg || !urlArg.startsWith("agentroom://")) {
    console.error("Usage: agentroom invite accept '<agentroom://invite/...>' --server <url>");
    process.exit(1);
  }

  // Validate URL format before connecting (fast-fail)
  if (!urlArg.startsWith("agentroom://invite/")) {
    console.error("Invalid invite URL format. Expected: agentroom://invite/<base64url>");
    process.exit(1);
  }

  const server = requireArg(args, "--server", "wss://host/ws");
  const home = getArg(args, "--home");
  let waitSec = parseInt(getArg(args, "--wait") ?? "10", 10);
  if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = 10;

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  const peerPk = await client.acceptInvite(urlArg);

  // Wait for SESSION_ACK → onPeerOnline before disconnecting
  // This ensures both sides have confirmed the handshake
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`handshake timeout after ${waitSec}s`)), waitSec * 1000);
    client.onPeerOnline((pk) => {
      if (pk === peerPk) { clearTimeout(t); resolve(); }
    });
  }).catch((err) => {
    console.warn(`[agentroom] ${err instanceof Error ? err.message : err} — session saved, peer may connect later`);
  });

  console.log("✓ Session established with peer:");
  console.log(peerPk);

  client.disconnect();
}
