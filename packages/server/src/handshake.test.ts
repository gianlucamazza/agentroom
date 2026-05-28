import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { createServer } from "http";
import {
  generateKeypair,
  createInvite,
  parseInviteUrl,
  sign,
  toBase64,
  fromBase64,
  sodiumReady,
  PROTOCOL_VERSION,
} from "@agentroom/protocol";
import { issueChallenge, issueSessionToken } from "./auth.js";
import { store } from "./store.js";
import { attachWss } from "./ws.js";
import { handleRequest } from "./routes.js";

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

  it("INVITE_CLAIM with mismatched signature is rejected (C1 fix)", async () => {
    process.env["RATE_LIMIT_DISABLED"] = "1";
    const srv = createServer(handleRequest);
    const wss2 = attachWss(srv);
    const url = await new Promise<string>((res, rej) => {
      srv.once("error", rej);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") { rej(new Error("bad addr")); return; }
        res(`ws://127.0.0.1:${addr.port}/ws`);
      });
    });
    const httpBase = url.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");

    const alice = await generateKeypair();
    const mallory = await generateKeypair();

    // Alice publishes an invite
    store.upsertAgent(toBase64(alice.ed25519_pk), toBase64(alice.x25519_pk));
    const inviteId = randomUUID();
    store.publishInvite(inviteId, "blob", toBase64(alice.ed25519_pk), Math.floor(Date.now() / 1000) + 3600);

    // Mallory authenticates with own identity
    const chResp = await fetch(`${httpBase}/auth/challenge`);
    const { challenge } = await chResp.json() as { challenge: string };
    const malloryWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", async () => {
        const sig = toBase64(await sign(new TextEncoder().encode(challenge), mallory.ed25519_sk));
        ws.send(JSON.stringify({
          v: PROTOCOL_VERSION, type: "HELLO", msg_id: randomUUID(), ts: Date.now(),
          ed25519_pk: toBase64(mallory.ed25519_pk), x25519_pk: toBase64(mallory.x25519_pk),
          sig, challenge,
        }));
      });
      ws.once("message", (raw) => {
        const f = JSON.parse(raw.toString()) as { type: string };
        if (f.type === "HELLO_ACK") resolve(ws); else reject(new Error(JSON.stringify(f)));
      });
      ws.once("error", reject);
    });

    // The attack: mallory sends INVITE_CLAIM with from=alice.pk but sig signed by mallory's key
    const ciphertextB64 = toBase64(new TextEncoder().encode("payload"));
    // Sig payload: from=alice.pk (lie), to=alice.pk, seq=0, nonce=ciphertextB64
    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: toBase64(alice.ed25519_pk), to: toBase64(alice.ed25519_pk), seq: 0, nonce: ciphertextB64 }),
    );
    const forgeSig = toBase64(await sign(sigPayload, mallory.ed25519_sk)); // signed with MALLORY'S key

    const response = await new Promise<{ type: string; code?: string }>((resolve) => {
      malloryWs.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      malloryWs.send(JSON.stringify({
        v: PROTOCOL_VERSION, type: "INVITE_CLAIM", msg_id: randomUUID(), ts: Date.now(),
        invite_id: inviteId,
        from: toBase64(alice.ed25519_pk), // lying about who the claimer is
        ciphertext: ciphertextB64, nonce: ciphertextB64,
        sig: forgeSig,
      }));
    });

    // Server verifies sig against frame.from (=alice.pk) but sig was made by mallory → INVALID_SIG
    expect(response.type).toBe("ERROR");
    expect(response.code).toBe("INVALID_SIG");

    malloryWs.close();
    await new Promise<void>((r) => srv.close(() => { wss2.close(); r(); }));
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
