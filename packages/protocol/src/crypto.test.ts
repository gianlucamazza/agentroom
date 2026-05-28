import { describe, it, expect } from "vitest";
import {
  sodiumReady,
  generateKeypair,
  sign,
  verify,
  dhSharedSecret,
  hkdf,
  seal,
  open,
  toBase64,
  fromBase64,
} from "./crypto.js";

describe("crypto primitives", () => {
  it("generateKeypair returns 4 non-empty keys", async () => {
    const kp = await generateKeypair();
    expect(kp.ed25519_pk.length).toBeGreaterThan(0);
    expect(kp.ed25519_sk.length).toBeGreaterThan(0);
    expect(kp.x25519_pk.length).toBeGreaterThan(0);
    expect(kp.x25519_sk.length).toBeGreaterThan(0);
  });

  it("sign + verify roundtrip", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello agentroom");
    const sig = await sign(msg, kp.ed25519_sk);
    expect(await verify(msg, sig, kp.ed25519_pk)).toBe(true);
  });

  it("verify rejects wrong key", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await sign(msg, kp1.ed25519_sk);
    expect(await verify(msg, sig, kp2.ed25519_pk)).toBe(false);
  });

  it("verify rejects tampered message", async () => {
    const kp = await generateKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = await sign(msg, kp.ed25519_sk);
    const tampered = new TextEncoder().encode("HELLO");
    expect(await verify(tampered, sig, kp.ed25519_pk)).toBe(false);
  });

  it("DH shared secret is symmetric", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const sharedAB = await dhSharedSecret(alice.x25519_sk, bob.x25519_pk);
    const sharedBA = await dhSharedSecret(bob.x25519_sk, alice.x25519_pk);
    expect(toBase64(sharedAB)).toBe(toBase64(sharedBA));
  });

  it("hkdf is deterministic", async () => {
    await sodiumReady();
    const ikm = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(16).fill(2);
    const k1 = await hkdf(ikm, salt, "test", 32);
    const k2 = await hkdf(ikm, salt, "test", 32);
    expect(toBase64(k1)).toBe(toBase64(k2));
  });

  it("hkdf different info → different keys", async () => {
    await sodiumReady();
    const ikm = new Uint8Array(32).fill(3);
    const salt = new Uint8Array(16).fill(4);
    const k1 = await hkdf(ikm, salt, "keyA", 32);
    const k2 = await hkdf(ikm, salt, "keyB", 32);
    expect(toBase64(k1)).not.toBe(toBase64(k2));
  });

  it("seal + open roundtrip", async () => {
    await sodiumReady();
    const key = new Uint8Array(32).fill(5);
    const plaintext = new TextEncoder().encode("secret message");
    const { ciphertext, nonce } = await seal(plaintext, key);
    const recovered = await open(ciphertext, nonce, key);
    expect(new TextDecoder().decode(recovered)).toBe("secret message");
  });

  it("open throws on wrong key", async () => {
    await sodiumReady();
    const key1 = new Uint8Array(32).fill(6);
    const key2 = new Uint8Array(32).fill(7);
    const plaintext = new TextEncoder().encode("secret");
    const { ciphertext, nonce } = await seal(plaintext, key1);
    await expect(open(ciphertext, nonce, key2)).rejects.toThrow();
  });

  it("toBase64 / fromBase64 roundtrip", async () => {
    await sodiumReady();
    const bytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
