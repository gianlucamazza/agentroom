import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, createInvite, toBase64, fromBase64, sodiumReady, messageKey, open } from "@agentroom/protocol";
import {
  SessionStore,
  deriveSessionKeys,
  encryptMessage,
  decryptMessage,
  serializeSession,
  deserializeSession,
  type RatchetState,
} from "./session.js";

beforeAll(async () => {
  await sodiumReady();
});

// Seeds the DH ratchet exactly like the client handshake: the inviter (alice) initiates,
// the invitee (bob) does not; both seed sendEphemeral=own identity and recvEphemeralPk=peer
// static x25519 pub — the mutually-known keys that bootstrap the alternating DH ratchet.
async function makeSessionPair() {
  const alice = await generateKeypair(); // inviter
  const bob = await generateKeypair();   // invitee
  const { signed } = await createInvite(alice.ed25519_pk, alice.ed25519_sk, alice.x25519_pk, "wss://test");
  const nonce = signed.blob.nonce;
  const aliceKeys = await deriveSessionKeys(alice.x25519_sk, bob.x25519_pk, nonce, "inviter");
  const bobKeys   = await deriveSessionKeys(bob.x25519_sk, alice.x25519_pk, nonce, "invitee");
  const store = new SessionStore();
  const aliceS = await store.init("bob", aliceKeys, { identity: alice, peerX25519Pk: bob.x25519_pk, initiateRatchet: true });
  const bobS   = await store.init("alice", bobKeys, { identity: bob, peerX25519Pk: alice.x25519_pk, initiateRatchet: false });
  return { alice, bob, aliceS, bobS };
}

async function sendRecv(senderS: RatchetState, receiverS: RatchetState, text: string): Promise<string> {
  const enc = await encryptMessage(senderS, new TextEncoder().encode(text));
  const plain = await decryptMessage(receiverS, enc.ciphertext, enc.nonce, senderS.sendSeq - 1, enc.ratchet_pk);
  return new TextDecoder().decode(plain);
}

describe("Double Ratchet session", () => {
  it("basic message roundtrip A→B", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    expect(await sendRecv(aliceS, bobS, "hello bob")).toBe("hello bob");
  });

  it("bidirectional multi-message sequence", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    for (let i = 0; i < 4; i++) {
      expect(await sendRecv(aliceS, bobS, `a${i}`)).toBe(`a${i}`);
      expect(await sendRecv(bobS, aliceS, `b${i}`)).toBe(`b${i}`);
    }
  });

  it("replay protection: second call with same seq is rejected", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    const enc = await encryptMessage(aliceS, new TextEncoder().encode("once"));
    const seq = aliceS.sendSeq - 1;
    await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk);
    await expect(
      decryptMessage(bobS, enc.ciphertext, enc.nonce, seq),
    ).rejects.toThrow("replay");
  });

  it("forward secrecy: compromised chain key cannot decrypt earlier messages", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    // Encrypt + decrypt msg0 (bob's recv chain advances)
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("msg0"));
    const seq0 = aliceS.sendSeq - 1;
    await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk);

    // Capture bob's chain key AFTER msg0 was decrypted (the "compromised" key)
    const compromisedChainKey = bobS.recvChainKey.slice();

    // Encrypt + decrypt msg1 (same send chain — no rotation without an inbound message)
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("msg1"));
    const seq1 = aliceS.sendSeq - 1;
    await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk);

    // The advanced (compromised) chain key cannot reconstruct the key used for msg0
    const wrongKey = await messageKey(new Uint8Array(compromisedChainKey), seq0);
    await expect(
      open(fromBase64(enc0.ciphertext), fromBase64(enc0.nonce), wrongKey),
    ).rejects.toThrow();
  });

  it("out-of-order delivery (skipped message keys)", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    // Encrypt two messages but deliver out of order
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("first"));
    const seq0 = aliceS.sendSeq - 1;
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("second"));
    const seq1 = aliceS.sendSeq - 1;

    // Deliver msg1 first (skips msg0 → stores skipped key for seq0)
    const text1 = await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk);
    expect(new TextDecoder().decode(text1)).toBe("second");

    // Now deliver msg0 (should be found in skipped keys)
    const text0 = await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk);
    expect(new TextDecoder().decode(text0)).toBe("first");
  });
});

describe("Double Ratchet PCS (DH ratchet)", () => {
  it("seeds sendEphemeral from identity and rotates it off on the first send", async () => {
    const { alice, aliceS, bobS } = await makeSessionPair();
    expect(toBase64(aliceS.sendEphemeral.x25519_pk)).toBe(toBase64(alice.x25519_pk)); // seeded = identity
    expect(aliceS.needsSendDhStep).toBe(true);   // inviter initiates
    expect(bobS.needsSendDhStep).toBe(false);    // invitee waits

    expect(await sendRecv(aliceS, bobS, "hi")).toBe("hi");

    // first send performed a DH step → ephemeral rotated off the long-term identity key
    expect(toBase64(aliceS.sendEphemeral.x25519_pk)).not.toBe(toBase64(alice.x25519_pk));
    expect(aliceS.needsSendDhStep).toBe(false);
    // bob ran the matching recv step; it now owes a send rotation and tracks alice's eph
    expect(bobS.needsSendDhStep).toBe(true);
    expect(toBase64(bobS.recvEphemeralPk)).toBe(toBase64(aliceS.sendEphemeral.x25519_pk));
  });

  it("ratchet_pk rotates every turn-around (post-compromise security)", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    const seen = new Set<string>();
    let lastAlice = "";
    for (let i = 0; i < 4; i++) {
      const ea = await encryptMessage(aliceS, new TextEncoder().encode(`a${i}`));
      seen.add(ea.ratchet_pk);
      const ta = await decryptMessage(bobS, ea.ciphertext, ea.nonce, aliceS.sendSeq - 1, ea.ratchet_pk);
      expect(new TextDecoder().decode(ta)).toBe(`a${i}`);
      if (i > 0) expect(ea.ratchet_pk).not.toBe(lastAlice); // a fresh ephemeral each turn
      lastAlice = ea.ratchet_pk;

      const eb = await encryptMessage(bobS, new TextEncoder().encode(`b${i}`));
      const tb = await decryptMessage(aliceS, eb.ciphertext, eb.nonce, bobS.sendSeq - 1, eb.ratchet_pk);
      expect(new TextDecoder().decode(tb)).toBe(`b${i}`);
    }
    expect(seen.size).toBe(4); // four distinct sending ephemerals over four turns
  });

  it("a send chain captured before a rotation cannot derive post-rotation keys", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    await sendRecv(aliceS, bobS, "a0");                 // alice rotates (first send)
    await sendRecv(bobS, aliceS, "b0");                 // alice receives → owes a rotation
    const staleSendChain = aliceS.sendChainKey.slice();

    const e1 = await encryptMessage(aliceS, new TextEncoder().encode("a1")); // rotation
    expect(toBase64(new Uint8Array(staleSendChain))).not.toBe(toBase64(aliceS.sendChainKey));

    // the stale chain's key for the same seq cannot open the post-rotation ciphertext
    const wrongKey = await messageKey(new Uint8Array(staleSendChain), aliceS.sendSeq - 1);
    await expect(
      open(fromBase64(e1.ciphertext), fromBase64(e1.nonce), wrongKey),
    ).rejects.toThrow();

    // sanity: the real recipient still decrypts it
    const t = await decryptMessage(bobS, e1.ciphertext, e1.nonce, aliceS.sendSeq - 1, e1.ratchet_pk);
    expect(new TextDecoder().decode(t)).toBe("a1");
  });

  it("out-of-order delivery within a post-rotation chain", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    const e0 = await encryptMessage(aliceS, new TextEncoder().encode("first"));  // rotation, seq0
    const s0 = aliceS.sendSeq - 1;
    const e1 = await encryptMessage(aliceS, new TextEncoder().encode("second")); // same eph, seq1
    const s1 = aliceS.sendSeq - 1;

    // deliver the second message first → key for the first is buffered as skipped
    expect(new TextDecoder().decode(
      await decryptMessage(bobS, e1.ciphertext, e1.nonce, s1, e1.ratchet_pk),
    )).toBe("second");
    expect(new TextDecoder().decode(
      await decryptMessage(bobS, e0.ciphertext, e0.nonce, s0, e0.ratchet_pk),
    )).toBe("first");
  });
});

describe("Session serialization", () => {
  it("serialize/deserialize roundtrip preserves all fields", async () => {
    const { aliceS } = await makeSessionPair();

    const json = serializeSession(aliceS);
    const restored = deserializeSession(json);

    expect(toBase64(restored.sendChainKey)).toBe(toBase64(aliceS.sendChainKey));
    expect(toBase64(restored.recvChainKey)).toBe(toBase64(aliceS.recvChainKey));
    expect(toBase64(restored.sendEphemeral.x25519_pk)).toBe(toBase64(aliceS.sendEphemeral.x25519_pk));
    expect(toBase64(restored.sendEphemeral.x25519_sk)).toBe(toBase64(aliceS.sendEphemeral.x25519_sk));
    expect(toBase64(restored.recvEphemeralPk)).toBe(toBase64(aliceS.recvEphemeralPk));
    expect(restored.needsSendDhStep).toBe(aliceS.needsSendDhStep);
    expect(restored.sendSeq).toBe(aliceS.sendSeq);
    expect(restored.recvSeq).toBe(aliceS.recvSeq);
    expect(restored.peerPk).toBe(aliceS.peerPk);
    expect(restored.lastUsedAt).toBeGreaterThan(0);
  });

  it("serialize/deserialize with skippedMessageKeys", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    // Produce a skip: deliver msg1 first, which stores key for msg0
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("skip-me"));
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("deliver-first"));
    const seq0 = aliceS.sendSeq - 2;
    const seq1 = aliceS.sendSeq - 1;

    await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk);
    expect(bobS.skippedMessageKeys.size).toBeGreaterThan(0);

    const json = serializeSession(bobS);
    const restored = deserializeSession(json);

    expect(restored.skippedMessageKeys.size).toBe(bobS.skippedMessageKeys.size);

    // Restored session can still decrypt the skipped message
    const text0 = await decryptMessage(restored, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk);
    expect(new TextDecoder().decode(text0)).toBe("skip-me");
  });

  it("restored session continues encryption correctly", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    // Send one message
    await sendRecv(aliceS, bobS, "msg0");

    // Serialize and restore alice's session (as if a new process)
    const restored = deserializeSession(serializeSession(aliceS));
    restored.peerPk = aliceS.peerPk;

    // Send another message from the restored state
    const enc = await encryptMessage(restored, new TextEncoder().encode("msg1"));
    const seq = restored.sendSeq - 1;
    const plain = await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk);
    expect(new TextDecoder().decode(plain)).toBe("msg1");
  });

  it("persists needsSendDhStep across serialize/deserialize", async () => {
    const { aliceS, bobS } = await makeSessionPair();
    await sendRecv(aliceS, bobS, "a0"); // bob now owes a send rotation
    expect(bobS.needsSendDhStep).toBe(true);

    const restored = deserializeSession(serializeSession(bobS));
    expect(restored.needsSendDhStep).toBe(true);

    // restored bob sends (rotates) and alice decrypts
    const e = await encryptMessage(restored, new TextEncoder().encode("b0"));
    const t = await decryptMessage(aliceS, e.ciphertext, e.nonce, restored.sendSeq - 1, e.ratchet_pk);
    expect(new TextDecoder().decode(t)).toBe("b0");
  });
});

describe("C3: atomic state — session survives decrypt failure", () => {
  it("session remains usable after decryptMessage throws on bad ciphertext", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    // Encrypt a legitimate message
    const enc = await encryptMessage(aliceS, new TextEncoder().encode("real msg"));
    const seq = aliceS.sendSeq - 1;

    // Corrupt the ciphertext (flip one byte)
    const ct = fromBase64(enc.ciphertext);
    const b = ct[0];
    if (b !== undefined) ct[0] = b ^ 0xff;
    const badCt = toBase64(ct);

    // Attempt to decrypt the corrupted message — must throw
    await expect(
      decryptMessage(bobS, badCt, enc.nonce, seq, enc.ratchet_pk),
    ).rejects.toThrow();

    // session state is rolled back — bob must still decrypt the original correctly
    const plain = await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk);
    expect(new TextDecoder().decode(plain)).toBe("real msg");
  });

  it("session chain advances normally after a replay attempt", async () => {
    const { aliceS, bobS } = await makeSessionPair();

    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("msg0"));
    const seq0 = aliceS.sendSeq - 1;

    // Decrypt once (normal)
    await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk);

    // Replay same message — must throw "replay detected"
    await expect(
      decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0),
    ).rejects.toThrow("replay");

    // Chain must still work for next message
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("msg1"));
    const seq1 = aliceS.sendSeq - 1;
    const plain = await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk);
    expect(new TextDecoder().decode(plain)).toBe("msg1");
  });
});

describe("C4: SessionStore per-instance isolation", () => {
  it("two SessionStore instances do not share sessions", async () => {
    const store1 = new SessionStore();
    const store2 = new SessionStore();

    const { aliceS } = await makeSessionPair();
    store1.set("peer-pk", aliceS);

    expect(store1.get("peer-pk")).toBe(aliceS);
    expect(store2.get("peer-pk")).toBeUndefined();
    expect(store1.list()).toContain("peer-pk");
    expect(store2.list()).not.toContain("peer-pk");
  });

  it("init creates session only in own store", async () => {
    const store1 = new SessionStore();
    const store2 = new SessionStore();

    const a = await generateKeypair();
    const b = await generateKeypair();
    const { signed } = await createInvite(a.ed25519_pk, a.ed25519_sk, a.x25519_pk, "wss://test");
    const keys = await deriveSessionKeys(a.x25519_sk, b.x25519_pk, signed.blob.nonce, "inviter");

    await store1.init("remote-pk", keys, { identity: a, peerX25519Pk: b.x25519_pk, initiateRatchet: true });

    expect(store1.get("remote-pk")).toBeDefined();
    expect(store2.get("remote-pk")).toBeUndefined();
  });
});
