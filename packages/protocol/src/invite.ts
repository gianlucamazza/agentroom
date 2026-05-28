import { randomUUID } from "crypto";
import {
  sign,
  verify,
  toBase64,
  fromBase64,
  sodiumReady,
  type Bytes,
} from "./crypto.js";

export interface InviteBlob {
  invite_id: string;
  inviter_ed25519_pk: string;
  inviter_x25519_pk: string;
  server_url: string;
  expires_at: number;
  nonce: string;
}

export interface SignedInvite {
  blob: InviteBlob;
  sig: string;
}

export async function createInvite(
  inviter_ed25519_pk: Bytes,
  inviter_ed25519_sk: Bytes,
  inviter_x25519_pk: Bytes,
  server_url: string,
  ttl_ms = 86_400_000,
): Promise<{ signed: SignedInvite; url: string }> {
  const sodium = await sodiumReady();
  const nonce = toBase64(sodium.randombytes_buf(16));

  const blob: InviteBlob = {
    invite_id: randomUUID(),
    inviter_ed25519_pk: toBase64(inviter_ed25519_pk),
    inviter_x25519_pk: toBase64(inviter_x25519_pk),
    server_url,
    expires_at: Date.now() + ttl_ms,
    nonce,
  };

  const blobBytes = new TextEncoder().encode(JSON.stringify(blob));
  const sigBytes = await sign(blobBytes, inviter_ed25519_sk);
  const signed: SignedInvite = { blob, sig: toBase64(sigBytes) };

  const encoded = toBase64(new TextEncoder().encode(JSON.stringify(signed)));
  const url = `agentroom://invite/${encoded}`;
  return { signed, url };
}

export async function parseInviteUrl(
  url: string,
): Promise<{ ok: true; signed: SignedInvite } | { ok: false; error: string }> {
  try {
    const prefix = "agentroom://invite/";
    if (!url.startsWith(prefix)) return { ok: false, error: "not an agentroom invite URL" };
    const encoded = url.slice(prefix.length);
    const json = new TextDecoder().decode(fromBase64(encoded));
    const signed = JSON.parse(json) as SignedInvite;

    if (!signed.blob || !signed.sig) return { ok: false, error: "malformed invite" };
    // 30s grace period for clock skew between peers
    const CLOCK_SKEW_GRACE_MS = 30_000;
    if (Date.now() > signed.blob.expires_at + CLOCK_SKEW_GRACE_MS) return { ok: false, error: "invite expired" };

    const blobBytes = new TextEncoder().encode(JSON.stringify(signed.blob));
    const valid = await verify(
      blobBytes,
      fromBase64(signed.sig),
      fromBase64(signed.blob.inviter_ed25519_pk),
    );
    if (!valid) return { ok: false, error: "invalid signature" };

    return { ok: true, signed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
