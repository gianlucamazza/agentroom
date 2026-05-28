import { describe, it, expect, vi } from "vitest";
import { generateKeypair } from "./crypto.js";
import { createInvite, parseInviteUrl } from "./invite.js";

describe("invite", () => {
  it("create + parse roundtrip", async () => {
    const kp = await generateKeypair();
    const { url } = await createInvite(kp.ed25519_pk, kp.ed25519_sk, kp.x25519_pk, "wss://test.local/ws");
    expect(url).toMatch(/^agentroom:\/\/invite\//);

    const result = await parseInviteUrl(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signed.blob.server_url).toBe("wss://test.local/ws");
  });

  it("rejects wrong prefix", async () => {
    const result = await parseInviteUrl("https://example.com/invite/foo");
    expect(result.ok).toBe(false);
  });

  it("rejects tampered blob signature", async () => {
    const kp = await generateKeypair();
    const kp2 = await generateKeypair();
    const { signed } = await createInvite(kp.ed25519_pk, kp.ed25519_sk, kp.x25519_pk, "wss://test.local/ws");

    // replace sig with one from a different key
    const { signed: tampered } = await createInvite(kp2.ed25519_pk, kp2.ed25519_sk, kp2.x25519_pk, "wss://test.local/ws");
    const crossedSigned = { blob: signed.blob, sig: tampered.sig };

    const { toBase64 } = await import("./crypto.js");
    const encoded = toBase64(new TextEncoder().encode(JSON.stringify(crossedSigned)));
    const result = await parseInviteUrl(`agentroom://invite/${encoded}`);
    expect(result.ok).toBe(false);
  });

  it("rejects expired invite (outside 30s clock-skew grace)", async () => {
    const kp = await generateKeypair();
    // ttl of -31_000ms → expired 31s ago, outside the 30s grace period
    const { url } = await createInvite(kp.ed25519_pk, kp.ed25519_sk, kp.x25519_pk, "wss://test.local/ws", -31_000);
    const result = await parseInviteUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expired");
  });

  it("accepts invite within 30s clock-skew grace period", async () => {
    const kp = await generateKeypair();
    // ttl of -10_000ms → expired 10s ago, still within the 30s grace
    const { url } = await createInvite(kp.ed25519_pk, kp.ed25519_sk, kp.x25519_pk, "wss://test.local/ws", -10_000);
    const result = await parseInviteUrl(url);
    expect(result.ok).toBe(true);
  });
});
