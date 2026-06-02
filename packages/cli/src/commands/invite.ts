import { AgentroomClient } from "@agentroom/sdk";
import { parseInviteUrl } from "@agentroom/protocol";
import { EXIT_USAGE } from "../exitcodes.js";

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

/**
 * Which relay to accept against. The invite blob already carries the inviter's
 * `server_url` (the tunnel), so an explicit --server is optional — it only
 * overrides. Returns null if neither is available (caller errors out).
 */
export function resolveAcceptServer(
  explicit: string | undefined,
  blobServerUrl: string | undefined,
): string | null {
  return explicit ?? blobServerUrl ?? null;
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

  const home = getArg(args, "--home");
  const jsonMode = args.includes("--json");
  let waitSec = parseInt(getArg(args, "--wait") ?? "10", 10);
  if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = 10;

  // The tunnel/relay URL lives inside the invite, so --server is optional here —
  // decode the blob first and fall back to its server_url. --server still overrides.
  const parsed = await parseInviteUrl(urlArg);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(EXIT_USAGE);
  }
  const server = resolveAcceptServer(getArg(args, "--server"), parsed.signed.blob.server_url);
  if (!server) {
    console.error("No relay URL: invite has no server_url and --server <wss://host/ws> was not given");
    process.exit(EXIT_USAGE);
  }

  const client = new AgentroomClient();
  await client.connect({ serverUrl: server, home });

  // Once acceptInvite resolves the session is established locally (bootstrap
  // keys derived from the invite). Confirmation that the peer is reachable comes
  // later, when the inviter processes our SESSION_INIT and replies SESSION_ACK
  // (→ onPeerOnline). But the inviter is normally OFFLINE here — `invite create`
  // publishes and disconnects — so our SESSION_INIT is queued store-and-forward
  // and no ACK arrives until they next connect. That is NOT a failure: treat the
  // peer-online confirmation as best-effort and always exit 0 on a saved session.
  const peerPk = await client.acceptInvite(urlArg);

  const peerOnline = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), waitSec * 1000);
    t.unref?.();
    client.onPeerOnline((pk) => {
      if (pk === peerPk) { clearTimeout(t); resolve(true); }
    });
  });

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, peer_pk: peerPk, peer_online: peerOnline }));
  } else if (peerOnline) {
    console.log("✓ Session established — peer online:");
    console.log(peerPk);
  } else {
    console.log("✓ Session saved — peer offline; they'll sync when they next connect:");
    console.log(peerPk);
  }

  client.disconnect();
}
