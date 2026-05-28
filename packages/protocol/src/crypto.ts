import _sodium from "libsodium-wrappers";

export type Bytes = Uint8Array;

export interface AgentKeypair {
  ed25519_pk: Bytes;
  ed25519_sk: Bytes;
  x25519_pk: Bytes;
  x25519_sk: Bytes;
}

let _ready = false;

export async function sodiumReady(): Promise<typeof _sodium> {
  if (!_ready) {
    await _sodium.ready;
    _ready = true;
  }
  return _sodium;
}

export async function generateKeypair(): Promise<AgentKeypair> {
  const sodium = await sodiumReady();
  const sign = sodium.crypto_sign_keypair();
  const dh = sodium.crypto_box_keypair();
  return {
    ed25519_pk: sign.publicKey,
    ed25519_sk: sign.privateKey,
    x25519_pk: dh.publicKey,
    x25519_sk: dh.privateKey,
  };
}

export async function sign(message: Bytes, sk: Bytes): Promise<Bytes> {
  const sodium = await sodiumReady();
  return sodium.crypto_sign_detached(message, sk);
}

export async function verify(
  message: Bytes,
  sig: Bytes,
  pk: Bytes,
): Promise<boolean> {
  const sodium = await sodiumReady();
  try {
    return sodium.crypto_sign_verify_detached(sig, message, pk);
  } catch {
    return false;
  }
}

export async function dhSharedSecret(
  our_sk: Bytes,
  their_pk: Bytes,
): Promise<Bytes> {
  const sodium = await sodiumReady();
  return sodium.crypto_scalarmult(our_sk, their_pk);
}

/** HKDF-SHA256: extract + expand */
export async function hkdf(
  ikm: Bytes,
  salt: Bytes,
  info: string,
  len = 32,
): Promise<Bytes> {
  const sodium = await sodiumReady();
  // extract
  const prk = sodium.crypto_generichash(32, ikm, salt);
  // expand: T(1) = HMAC(prk, info || 0x01)
  const infoBytes = new TextEncoder().encode(info);
  const t1Input = new Uint8Array(infoBytes.length + 1);
  t1Input.set(infoBytes);
  t1Input[infoBytes.length] = 0x01;
  const okm = sodium.crypto_generichash(len, t1Input, prk);
  return okm;
}

/** XChaCha20-Poly1305 seal (encrypt + authenticate). Returns nonce||ciphertext. */
export async function seal(
  plaintext: Bytes,
  key: Bytes,
): Promise<{ ciphertext: Bytes; nonce: Bytes }> {
  const sodium = await sodiumReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return { ciphertext, nonce };
}

/** XChaCha20-Poly1305 open (decrypt + verify). Throws on auth failure. */
export async function open(
  ciphertext: Bytes,
  nonce: Bytes,
  key: Bytes,
): Promise<Bytes> {
  const sodium = await sodiumReady();
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (!plaintext) throw new Error("decryption failed: authentication error");
  return plaintext;
}

export function toBase64(b: Bytes): string {
  return Buffer.from(b).toString("base64url");
}

export function fromBase64(s: string): Bytes {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function randomBytes(n: number): Bytes {
  return _sodium.randombytes_buf(n);
}

/**
 * Double Ratchet step: given current root key and a new DH output,
 * produces a new root key and a chain key.
 * Both parties compute the same output given the same inputs.
 */
export async function ratchetStep(
  rootKey: Bytes,
  dhOutput: Bytes,
): Promise<{ newRootKey: Bytes; chainKey: Bytes }> {
  const newRootKey = await hkdf(dhOutput, rootKey, "agentroom-v2-root", 32);
  const chainKey = await hkdf(dhOutput, rootKey, "agentroom-v2-chain", 32);
  return { newRootKey, chainKey };
}

/** Derive a per-message encryption key from a chain key + counter */
export async function messageKey(chainKey: Bytes, seq: number): Promise<Bytes> {
  const sodium = await sodiumReady();
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq, false);
  return sodium.crypto_generichash(32, seqBytes, chainKey);
}

