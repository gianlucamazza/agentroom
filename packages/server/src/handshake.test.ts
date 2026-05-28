import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import {
  generateKeypair,
  createInvite,
  parseInviteUrl,
  toBase64,
  fromBase64,
  sodiumReady,
} from "@agentroom/protocol";
import { issueChallenge, issueSessionToken } from "./auth.js";
import { store } from "./store.js";

beforeAll(async () => {
  process.env["HMAC_SECRET"] = "a".repeat(32);
  process.env["AGENTROOM_DB"] = ":memory:";
  await sodiumReady();
});

describe("auth: challenge → HELLO flow", () => {
  it("issueChallenge returns a non-empty string", () => {
    const c = issueChallenge();
    expect(typeof c).toBe("string");
    expect(c.length).toBeGreaterThan(0);
  });

  it("challenge is single-use", async () => {
    const { consumeChallenge } = await import("./auth.js");
    const c = issueChallenge();
    expect(consumeChallenge(c)).toBe(true);
    expect(consumeChallenge(c)).toBe(false);
  });

  it("session token verify roundtrip", async () => {
    const { verifySessionToken } = await import("./auth.js");
    const kp_pk = "testpk_abc123";
    const token = issueSessionToken(kp_pk);
    const result = verifySessionToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.pk).toBe(kp_pk);
  });

  it("session token rejects tampered payload", async () => {
    const { verifySessionToken } = await import("./auth.js");
    const token = issueSessionToken("pk1");
    const [p, mac] = token.split(".");
    const tampered = `${p}X.${mac}`;
    const result = verifySessionToken(tampered);
    expect(result.valid).toBe(false);
  });
});

describe("store: agents + invites + pending", () => {
  it("upsert + get agent", () => {
    store.upsertAgent("pk_test_1", "xpk_test_1");
    const agent = store.getAgent("pk_test_1");
    expect(agent).toBeDefined();
    expect(agent?.x25519_pk).toBe("xpk_test_1");
  });

  it("publish + claim invite (single-use)", () => {
    const id = randomUUID();
    store.publishInvite(id, "blob", "inviter_pk", Math.floor(Date.now() / 1000) + 3600);
    expect(store.claimInvite(id)).toBe(true);
    expect(store.claimInvite(id)).toBe(false);
  });

  it("invite expired → claim fails", () => {
    const id = randomUUID();
    store.publishInvite(id, "blob", "inviter_pk", Math.floor(Date.now() / 1000) - 1);
    expect(store.claimInvite(id)).toBe(false);
  });

  it("pending messages enqueue + dequeue + delete", () => {
    const msgId = randomUUID();
    store.enqueuePending(msgId, "recipient_pk", JSON.stringify({ test: 1 }));
    const msgs = store.dequeuePending("recipient_pk");
    expect(msgs.some((m) => m.id === msgId)).toBe(true);
    store.deletePending(msgId);
    const after = store.dequeuePending("recipient_pk");
    expect(after.some((m) => m.id === msgId)).toBe(false);
  });
});

describe("crypto: full E2E invite handshake simulation", () => {
  it("alice invites bob, both derive same session keys", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const { url } = await createInvite(
      alice.ed25519_pk,
      alice.ed25519_sk,
      alice.x25519_pk,
      "wss://test.local/ws",
    );

    const parsed = await parseInviteUrl(url);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { deriveSessionKeys } = await import("@agentroom/sdk");
    const bobKeys = await deriveSessionKeys(
      bob.x25519_sk,
      fromBase64(parsed.signed.blob.inviter_x25519_pk),
      parsed.signed.blob.nonce,
      "invitee",
    );

    const aliceKeys = await deriveSessionKeys(
      alice.x25519_sk,
      bob.x25519_pk,
      parsed.signed.blob.nonce,
      "inviter",
    );

    expect(toBase64(aliceKeys.sendKey)).toBe(toBase64(bobKeys.recvKey));
    expect(toBase64(bobKeys.sendKey)).toBe(toBase64(aliceKeys.recvKey));
  });

  it("message encrypt → decrypt E2E (ratchet)", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const { signed } = await createInvite(alice.ed25519_pk, alice.ed25519_sk, alice.x25519_pk, "wss://test.local/ws");
    const { deriveSessionKeys, initRatchetSession, encryptMessage, decryptMessage } = await import("@agentroom/sdk");

    const aliceKeys = await deriveSessionKeys(alice.x25519_sk, bob.x25519_pk, signed.blob.nonce, "inviter");
    const bobKeys   = await deriveSessionKeys(bob.x25519_sk, alice.x25519_pk, signed.blob.nonce, "invitee");

    const aliceSession = await initRatchetSession(toBase64(bob.ed25519_pk), aliceKeys);
    const bobSession   = await initRatchetSession(toBase64(alice.ed25519_pk), bobKeys);

    const plaintext = new TextEncoder().encode("hello from alice");
    const { ciphertext, nonce, ratchet_pk } = await encryptMessage(aliceSession, plaintext);
    const seq = aliceSession.sendSeq - 1;

    const recovered = await decryptMessage(bobSession, ciphertext, nonce, seq, ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(recovered)).toBe("hello from alice");
  });

  it("replay protection: same seq rejected", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const { signed } = await createInvite(alice.ed25519_pk, alice.ed25519_sk, alice.x25519_pk, "wss://test.local/ws");
    const { deriveSessionKeys, initRatchetSession, encryptMessage, decryptMessage } = await import("@agentroom/sdk");

    const aliceKeys = await deriveSessionKeys(alice.x25519_sk, bob.x25519_pk, signed.blob.nonce, "inviter");
    const bobKeys   = await deriveSessionKeys(bob.x25519_sk, alice.x25519_pk, signed.blob.nonce, "invitee");

    const aliceSession = await initRatchetSession("alice-peer", aliceKeys);
    const bobSession   = await initRatchetSession("bob-peer",   bobKeys);

    const msg = new TextEncoder().encode("first");
    const { ciphertext, nonce, ratchet_pk } = await encryptMessage(aliceSession, msg);
    const seq = aliceSession.sendSeq - 1;

    await decryptMessage(bobSession, ciphertext, nonce, seq, undefined, bob.x25519_sk);
    // replay without ratchet_pk → caught by recvSeq check
    await expect(decryptMessage(bobSession, ciphertext, nonce, seq)).rejects.toThrow("replay");
    void ratchet_pk;
  });
});
