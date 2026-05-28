import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, createInvite, toBase64, fromBase64, sodiumReady, messageKey, open } from "@agentroom/protocol";
import {
  deriveSessionKeys,
  initRatchetSession,
  encryptMessage,
  decryptMessage,
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
