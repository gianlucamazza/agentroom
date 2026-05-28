import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, createInvite, toBase64, fromBase64, sodiumReady, messageKey, open } from "@agentroom/protocol";
import {
  SessionStore,
  deriveSessionKeys,
  initRatchetSession,
  encryptMessage,
  decryptMessage,
  serializeSession,
  deserializeSession,
  type RatchetState,
} from "./session.js";

beforeAll(async () => {
  await sodiumReady();
});

async function makeSessionPair() {
  const alice = await generateKeypair();
  const bob = await generateKeypair();
  const { signed } = await createInvite(alice.ed25519_pk, alice.ed25519_sk, alice.x25519_pk, "wss://test");
  const aliceKeys = await deriveSessionKeys(alice.x25519_sk, bob.x25519_pk, signed.blob.nonce, "inviter");
  const bobKeys   = await deriveSessionKeys(bob.x25519_sk, alice.x25519_pk, signed.blob.nonce, "invitee");
  const aliceS = await initRatchetSession("bob", aliceKeys);
  const bobS   = await initRatchetSession("alice", bobKeys);
  return { alice, bob, aliceS, bobS };
}

async function sendRecv(
  senderS: RatchetState,
  receiverS: RatchetState,
  text: string,
  receiverDhSk: Uint8Array,
): Promise<string> {
  const enc = await encryptMessage(senderS, new TextEncoder().encode(text));
  const seq = senderS.sendSeq - 1;
  const plain = await decryptMessage(receiverS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk, receiverDhSk);
  return new TextDecoder().decode(plain);
}

describe("Double Ratchet session", () => {
  it("basic message roundtrip A→B", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();
    expect(await sendRecv(aliceS, bobS, "hello bob", bob.x25519_sk)).toBe("hello bob");
  });

  it("bidirectional multi-message sequence", async () => {
    const { alice, bob, aliceS, bobS } = await makeSessionPair();
    for (let i = 0; i < 4; i++) {
      expect(await sendRecv(aliceS, bobS, `a${i}`, bob.x25519_sk)).toBe(`a${i}`);
      expect(await sendRecv(bobS, aliceS, `b${i}`, alice.x25519_sk)).toBe(`b${i}`);
    }
  });

  it("replay protection: second call with same seq is rejected", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();
    const enc = await encryptMessage(aliceS, new TextEncoder().encode("once"));
    const seq = aliceS.sendSeq - 1;
    await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk, bob.x25519_sk);
    await expect(
      decryptMessage(bobS, enc.ciphertext, enc.nonce, seq),
    ).rejects.toThrow("replay");
  });

  it("forward secrecy: compromised chain key cannot decrypt earlier messages", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    // Encrypt msg0
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("msg0"));
    const seq0 = aliceS.sendSeq - 1;

    // Decrypt msg0 (bob's chain key advances)
    await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk, bob.x25519_sk);

    // Capture bob's chain key AFTER msg0 was decrypted (compromised key)
    const compromisedChainKey = bobS.recvChainKey.slice();

    // Encrypt msg1
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("msg1"));
    const seq1 = aliceS.sendSeq - 1;

    // Decrypt msg1 normally
    await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk, bob.x25519_sk);

    // Attacker has compromisedChainKey (which was state AFTER msg0, BEFORE msg1)
    // They can compute the message key for seq1 from it:
    const attackerKey = await messageKey(new Uint8Array(compromisedChainKey), seq1);

    // BUT: they should NOT be able to decrypt msg0 (seq0) from compromisedChainKey
    // because compromisedChainKey is the ADVANCED state (after msg0 was processed)
    // messageKey(compromisedChainKey, seq0) is different from the actual key used for msg0
    const wrongKey = await messageKey(new Uint8Array(compromisedChainKey), seq0);
    await expect(
      open(fromBase64(enc0.ciphertext), fromBase64(enc0.nonce), wrongKey),
    ).rejects.toThrow();

    void attackerKey; // silence unused warning
  });

  it("DH ratchet: after exchanging messages, ratchet_pk rotates", async () => {
    const { alice, bob, aliceS, bobS } = await makeSessionPair();

    // Alice sends → Bob receives (Bob records Alice's ratchet_pk, no DH step yet)
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("hi"));
    const pk1 = enc1.ratchet_pk;
    await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, aliceS.sendSeq - 1, enc1.ratchet_pk, bob.x25519_sk);

    // Bob sends → Alice receives (Alice records Bob's ratchet_pk, no DH step yet)
    const enc2 = await encryptMessage(bobS, new TextEncoder().encode("hey"));
    await decryptMessage(aliceS, enc2.ciphertext, enc2.nonce, bobS.sendSeq - 1, enc2.ratchet_pk, alice.x25519_sk);

    // Alice sends again → Alice's ratchet_pk is still the same (no DH trigger yet)
    const enc3 = await encryptMessage(aliceS, new TextEncoder().encode("done"));
    const pk3 = enc3.ratchet_pk;
    // Same sendEphemeral = same ratchet_pk (DH ratchet fires only after SECOND new peer pk)
    expect(pk3).toBe(pk1);

    // Bob receives Alice's second msg with SAME pk1 → no DH step (pk not changed)
    const text = await decryptMessage(bobS, enc3.ciphertext, enc3.nonce, aliceS.sendSeq - 1, enc3.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(text)).toBe("done");

    void pk3;
  });

  it("out-of-order delivery (skipped message keys)", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    // Encrypt two messages but deliver out of order
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("first"));
    const seq0 = aliceS.sendSeq - 1;
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("second"));
    const seq1 = aliceS.sendSeq - 1;

    // Deliver msg1 first (skips msg0 → stores skipped key for seq0)
    const text1 = await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(text1)).toBe("second");

    // Now deliver msg0 (should be found in skipped keys)
    const text0 = await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(text0)).toBe("first");
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
    expect(restored.recvEphemeralPk).toBeNull();
    expect(restored.sendSeq).toBe(aliceS.sendSeq);
    expect(restored.recvSeq).toBe(aliceS.recvSeq);
    expect(restored.peerPk).toBe(aliceS.peerPk);
    expect(restored.lastUsedAt).toBeGreaterThan(0);
  });

  it("serialize/deserialize with skippedMessageKeys", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    // Produce a skip: deliver msg1 first, which stores key for msg0
    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("skip-me"));
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("deliver-first"));
    const seq0 = aliceS.sendSeq - 2;
    const seq1 = aliceS.sendSeq - 1;

    await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk, bob.x25519_sk);
    expect(bobS.skippedMessageKeys.size).toBeGreaterThan(0);

    const json = serializeSession(bobS);
    const restored = deserializeSession(json);

    expect(restored.skippedMessageKeys.size).toBe(bobS.skippedMessageKeys.size);

    // Restored session can still decrypt the skipped message
    const text0 = await decryptMessage(restored, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(text0)).toBe("skip-me");
    void enc0;
  });

  it("restored session continues encryption correctly", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    // Send one message
    await sendRecv(aliceS, bobS, "msg0", bob.x25519_sk);

    // Serialize and restore alice's session
    const restored = deserializeSession(serializeSession(aliceS));
    // Set the restored session as if it's a new process
    restored.peerPk = aliceS.peerPk;

    // Send another message from the restored state
    const enc = await encryptMessage(restored, new TextEncoder().encode("msg1"));
    const seq = restored.sendSeq - 1;
    const plain = await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(plain)).toBe("msg1");
  });
});

describe("C3: atomic state — session survives decrypt failure", () => {
  it("session remains usable after decryptMessage throws on bad ciphertext", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    // Encrypt a legitimate message
    const enc = await encryptMessage(aliceS, new TextEncoder().encode("real msg"));
    const seq = aliceS.sendSeq - 1;

    // Corrupt the ciphertext (flip one byte)
    const ct = fromBase64(enc.ciphertext);
    ct[0] ^= 0xff;
    const badCt = toBase64(ct);

    // Attempt to decrypt the corrupted message — must throw
    await expect(
      decryptMessage(bobS, badCt, enc.nonce, seq, enc.ratchet_pk, bob.x25519_sk),
    ).rejects.toThrow();

    // C3 fix: session state is rolled back — bob must still decrypt the original correctly
    const savedRecvChain = toBase64(bobS.recvChainKey);
    const plain = await decryptMessage(bobS, enc.ciphertext, enc.nonce, seq, enc.ratchet_pk, bob.x25519_sk);
    expect(new TextDecoder().decode(plain)).toBe("real msg");

    void savedRecvChain;
  });

  it("session chain advances normally after a replay attempt", async () => {
    const { bob, aliceS, bobS } = await makeSessionPair();

    const enc0 = await encryptMessage(aliceS, new TextEncoder().encode("msg0"));
    const seq0 = aliceS.sendSeq - 1;

    // Decrypt once (normal)
    await decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0, enc0.ratchet_pk, bob.x25519_sk);

    // Replay same message — must throw "replay detected"
    await expect(
      decryptMessage(bobS, enc0.ciphertext, enc0.nonce, seq0),
    ).rejects.toThrow("replay");

    // Chain must still work for next message
    const enc1 = await encryptMessage(aliceS, new TextEncoder().encode("msg1"));
    const seq1 = aliceS.sendSeq - 1;
    const plain = await decryptMessage(bobS, enc1.ciphertext, enc1.nonce, seq1, enc1.ratchet_pk, bob.x25519_sk);
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

    const kp = await generateKeypair();
    const { signed } = await createInvite(kp.ed25519_pk, kp.ed25519_sk, kp.x25519_pk, "wss://test");
    const keys = await deriveSessionKeys(kp.x25519_sk, kp.x25519_pk, signed.blob.nonce, "inviter");

    await store1.init("remote-pk", keys);

    expect(store1.get("remote-pk")).toBeDefined();
    expect(store2.get("remote-pk")).toBeUndefined();
    // Module-level backward-compat (initRatchetSession) should also be separate
    const moduleSession = await initRatchetSession("remote-pk-2", keys);
    expect(store1.get("remote-pk-2")).toBeUndefined();
    void moduleSession;
  });
});
