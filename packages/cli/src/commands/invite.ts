import { AgentroomClient } from "@agentroom/sdk";
import { EXIT_USAGE, EXIT_NETWORK } from "../exitcodes.js";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireArg(args: string[], flag: string, name: string): string {
  const v = getArg(args, flag);
  if (!v) {
    console.error(`Missing ${flag} <${name}>`);
    process.exit(EXIT_USAGE);
  }
  return v;
}

export async function cmdInviteCreate(args: string[]) {
  const server = requireArg(args, "--server", "wss://host/ws");
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  const { url, invite_id } = await client.createInvite();

  if (jsonMode) {
    console.log(JSON.stringify({ url, invite_id }));
  } else {
    console.log("\nInvite URL (share out-of-band):\n");
    console.log(url);
    console.log("\nExpires in 24 hours. Single use.");
  }

  client.disconnect();
}

export async function cmdInviteAccept(args: string[]) {
  // agentroom invite accept '<url>' --server wss://host/ws [--home] [--wait <s>] [--json]
  const urlArg = args[0];
  if (!urlArg || !urlArg.startsWith("agentroom://")) {
    console.error("Usage: agentroom invite accept '<agentroom://invite/...>' --server <url>");
    process.exit(EXIT_USAGE);
  }

  // Validate URL format before connecting (fast-fail) — B6 in original audit
  if (!urlArg.startsWith("agentroom://invite/")) {
    console.error("Invalid invite URL format. Expected: agentroom://invite/<base64url>");
    process.exit(EXIT_USAGE);
  }

  const server = requireArg(args, "--server", "wss://host/ws");
  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  let waitSec = parseInt(getArg(args, "--wait") ?? "10", 10);
  if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = 10;

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  const peerPk = await client.acceptInvite(urlArg);

  // Wait for SESSION_ACK → onPeerOnline before disconnecting
  let timedOut = false;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      timedOut = true;
      reject(new Error(`handshake timeout after ${waitSec}s`));
    }, waitSec * 1000);
    client.onPeerOnline((pk) => {
      if (pk === peerPk) { clearTimeout(t); resolve(); }
    });
  }).catch((err) => {
    if (jsonMode) {
      console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.warn(`[agentroom] ${err instanceof Error ? err.message : err} — session saved, peer may connect later`);
    }
    if (timedOut) process.exitCode = EXIT_NETWORK;
  });

  if (!timedOut) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, peer_pk: peerPk }));
    } else {
      console.log("✓ Session established with peer:");
      console.log(peerPk);
    }
  } else if (!jsonMode) {
    console.log(peerPk);
  }

  client.disconnect();
}
