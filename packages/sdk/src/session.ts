import {
  dhSharedSecret,
  hkdf,
  seal,
  open,
  sign,
  verify,
  toBase64,
  fromBase64,
  ratchetStep,
  messageKey,
  generateKeypair,
  type Bytes,
  type AgentKeypair,
} from "@agentroom/protocol";

export interface SessionKeys {
  sendKey: Bytes;
  recvKey: Bytes;
}

/** Derive initial symmetric keys from a static DH exchange (bootstrap). */
export async function deriveSessionKeys(
  our_dh_sk: Bytes,
  their_dh_pk: Bytes,
  nonce: string,
  role: "inviter" | "invitee",
): Promise<SessionKeys> {
  const shared = await dhSharedSecret(our_dh_sk, their_dh_pk);
  const saltBytes = fromBase64(nonce);
  const keyA = await hkdf(shared, saltBytes, "agentroom-v1-keyA", 32);
  const keyB = await hkdf(shared, saltBytes, "agentroom-v1-keyB", 32);
  return role === "inviter"
    ? { sendKey: keyA, recvKey: keyB }
    : { sendKey: keyB, recvKey: keyA };
}

// ─────────────────────────────────────────────
// Symmetric KDF Ratchet + DH Ratchet state (v2)
//
// Model:
//  • Each message advances the send/recv chain key: forward secrecy (symmetric ratchet)
//  • ratchet_pk carries sender's current X25519 ephemeral; receiver records it for DH step
//  • Full DH ratchet step (post-compromise security) fires when peer's ratchet_pk changes
//    AND we have previously received at least one message from them (so we have their real pk)
// ─────────────────────────────────────────────

export interface RatchetState {
  peerPk: string;

  sendChainKey: Bytes;
  recvChainKey: Bytes;

  // DH ratchet fields
  sendEphemeral: AgentKeypair;
  recvEphemeralPk: Bytes | null;  // null = not yet received any message from peer

  sendSeq: number;
  recvSeq: number;

  // Out-of-order buffer: "peerEphPk_b64:seq" → { key, addedAt }
  skippedMessageKeys: Map<string, { key: Bytes; addedAt: number }>;

  /** Unix ms of last encrypt/decrypt — used for pruning stale sessions */
  lastUsedAt: number;
}

// ─────────────────────────────────────────────
// Serialization / Deserialization
// ─────────────────────────────────────────────

interface SerializedRatchetState {
  peerPk: string;
  sendChainKey: string;
  recvChainKey: string;
  sendEphemeral: { ed25519_pk: string; ed25519_sk: string; x25519_pk: string; x25519_sk: string };
  recvEphemeralPk: string | null;
  sendSeq: number;
  recvSeq: number;
  skippedMessageKeys: Array<[string, { key: string; addedAt: number }]>;
  lastUsedAt: number;
}

export function serializeSession(state: RatchetState): string {
  const serialized: SerializedRatchetState = {
    peerPk: state.peerPk,
    sendChainKey: toBase64(state.sendChainKey),
    recvChainKey: toBase64(state.recvChainKey),
    sendEphemeral: {
      ed25519_pk: toBase64(state.sendEphemeral.ed25519_pk),
      ed25519_sk: toBase64(state.sendEphemeral.ed25519_sk),
      x25519_pk: toBase64(state.sendEphemeral.x25519_pk),
      x25519_sk: toBase64(state.sendEphemeral.x25519_sk),
    },
    recvEphemeralPk: state.recvEphemeralPk ? toBase64(state.recvEphemeralPk) : null,
    sendSeq: state.sendSeq,
    recvSeq: state.recvSeq,
    skippedMessageKeys: [...state.skippedMessageKeys.entries()].map(
      ([k, v]) => [k, { key: toBase64(v.key), addedAt: v.addedAt }],
    ),
    lastUsedAt: state.lastUsedAt,
  };
  return JSON.stringify(serialized, null, 2);
}

export function deserializeSession(json: string): RatchetState {
  const s = JSON.parse(json) as SerializedRatchetState;
  const skippedMap = new Map<string, { key: Bytes; addedAt: number }>(
    s.skippedMessageKeys.map(([k, v]) => [k, { key: fromBase64(v.key), addedAt: v.addedAt }]),
  );
  return {
    peerPk: s.peerPk,
    sendChainKey: fromBase64(s.sendChainKey),
    recvChainKey: fromBase64(s.recvChainKey),
    sendEphemeral: {
      ed25519_pk: fromBase64(s.sendEphemeral.ed25519_pk),
      ed25519_sk: fromBase64(s.sendEphemeral.ed25519_sk),
      x25519_pk: fromBase64(s.sendEphemeral.x25519_pk),
      x25519_sk: fromBase64(s.sendEphemeral.x25519_sk),
    },
    recvEphemeralPk: s.recvEphemeralPk ? fromBase64(s.recvEphemeralPk) : null,
    sendSeq: s.sendSeq,
    recvSeq: s.recvSeq,
    skippedMessageKeys: skippedMap,
    lastUsedAt: s.lastUsedAt ?? Date.now(),
  };
}

const MAX_SKIP = 100;
const SKIP_KEY_TTL_MS = 5 * 60_000;

const sessions = new Map<string, RatchetState>();

export function getSession(peerPk: string): RatchetState | undefined {
  return sessions.get(peerPk);
}

export function setSession(peerPk: string, session: RatchetState): void {
  sessions.set(peerPk, session);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

/**
 * Initialize a ratchet session from static DH bootstrap keys.
 */
export async function initRatchetSession(
  peerPk: string,
  bootstrapKeys: SessionKeys,
): Promise<RatchetState> {
  const sendEphemeral = await generateKeypair();
  const session: RatchetState = {
    peerPk,
    sendChainKey: bootstrapKeys.sendKey,
    recvChainKey: bootstrapKeys.recvKey,
    sendEphemeral,
    recvEphemeralPk: null,
    sendSeq: 0,
    recvSeq: -1,
    skippedMessageKeys: new Map(),
    lastUsedAt: Date.now(),
  };
  sessions.set(peerPk, session);
  return session;
}

/** Encrypt a message, advancing the send chain (symmetric ratchet). */
export async function encryptMessage(
  session: RatchetState,
  plaintext: Bytes,
): Promise<{ ciphertext: string; nonce: string; ratchet_pk: string }> {
  const msgKey = await messageKey(session.sendChainKey, session.sendSeq);
  const { ciphertext, nonce } = await seal(plaintext, msgKey);

  // Advance send chain (forward secrecy: old key discarded)
  const { chainKey: nextChainKey } = await ratchetStep(session.sendChainKey, msgKey);
  session.sendChainKey = nextChainKey;
  session.sendSeq++;
  session.lastUsedAt = Date.now();

  return {
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    ratchet_pk: toBase64(session.sendEphemeral.x25519_pk),
  };
}

/**
 * Decrypt a message.
 * - Checks skipped message keys for out-of-order delivery
 * - Performs DH ratchet when peer's ratchet_pk changes (forward secrecy extension)
 * - our_dh_sk: our current X25519 private key for DH ratchet (optional; needed for DH step)
 */
export async function decryptMessage(
  session: RatchetState,
  ciphertext: string,
  nonce: string,
  seq: number,
  ratchet_pk_b64?: string,
  our_dh_sk?: Bytes,
): Promise<Bytes> {
  // Check skipped message keys (out-of-order)
  const skipKey = `${ratchet_pk_b64 ?? ""}:${seq}`;
  const skipped = session.skippedMessageKeys.get(skipKey);
  if (skipped) {
    session.skippedMessageKeys.delete(skipKey);
    return open(fromBase64(ciphertext), fromBase64(nonce), skipped.key);
  }

  // Replay check
  if (seq <= session.recvSeq) {
    throw new Error(`replay detected: seq ${seq} <= last seen ${session.recvSeq}`);
  }

  // DH ratchet step: only when peer changes their ratchet_pk AND we've seen them before
  if (ratchet_pk_b64 && our_dh_sk && session.recvEphemeralPk !== null) {
    const prevPkB64 = toBase64(session.recvEphemeralPk);
    if (ratchet_pk_b64 !== prevPkB64) {
      // Store skipped keys from current recv chain before ratcheting
      await storeSkippedKeys(session, prevPkB64, seq);

      const newPeerPk = fromBase64(ratchet_pk_b64);
      const dhOut = await dhSharedSecret(our_dh_sk, newPeerPk);
      const { chainKey: newRecvChain } = await ratchetStep(session.recvChainKey, dhOut);
      session.recvChainKey = newRecvChain;
      session.recvEphemeralPk = newPeerPk;
      // Reset recv counter for the new chain
      session.recvSeq = -1;

      // Advance our own send ephemeral for the next send
      const newSendEph = await generateKeypair();
      const dhOut2 = await dhSharedSecret(newSendEph.x25519_sk, newPeerPk);
      const { chainKey: newSendChain } = await ratchetStep(session.sendChainKey, dhOut2);
      session.sendChainKey = newSendChain;
      session.sendEphemeral = newSendEph;
      session.sendSeq = 0;
    }
  } else if (ratchet_pk_b64 && session.recvEphemeralPk === null) {
    // First message from peer: record their ratchet_pk (no DH step yet)
    session.recvEphemeralPk = fromBase64(ratchet_pk_b64);
  }

  // Store skipped keys if seq > recvSeq + 1 (out-of-order: advance chain to seq)
  const peerPkForSkip = ratchet_pk_b64 ?? (session.recvEphemeralPk ? toBase64(session.recvEphemeralPk) : "");
  if (seq > session.recvSeq + 1) {
    await storeSkippedKeys(session, peerPkForSkip, seq);
  }

  // Decrypt with current recv chain
  const msgKey = await messageKey(session.recvChainKey, seq);
  const plaintext = await open(fromBase64(ciphertext), fromBase64(nonce), msgKey);

  // Advance recv chain
  const { chainKey: nextChainKey } = await ratchetStep(session.recvChainKey, msgKey);
  session.recvChainKey = nextChainKey;
  session.recvSeq = seq;
  session.lastUsedAt = Date.now();

  return plaintext;
}

/**
 * Advance recv chain from recvSeq+1 to upToSeq-1, storing skipped message keys.
 * Updates session.recvChainKey to the state at upToSeq.
 */
async function storeSkippedKeys(
  session: RatchetState,
  peerPkB64: string,
  upToSeq: number,
): Promise<void> {
  const startSeq = session.recvSeq + 1;
  if (upToSeq <= startSeq) return;
  const count = Math.min(upToSeq - startSeq, MAX_SKIP);
  const now = Date.now();

  // Prune stale entries
  for (const [k, v] of session.skippedMessageKeys) {
    if (now - v.addedAt > SKIP_KEY_TTL_MS) session.skippedMessageKeys.delete(k);
  }

  let chainKey = session.recvChainKey;
  for (let i = 0; i < count; i++) {
    const s = startSeq + i;
    const key = await messageKey(chainKey, s);
    const { chainKey: next } = await ratchetStep(chainKey, key);
    session.skippedMessageKeys.set(`${peerPkB64}:${s}`, { key, addedAt: now });
    chainKey = next;
  }
  // Update recv chain to the state at upToSeq
  session.recvChainKey = chainKey;
  session.recvSeq = startSeq + count - 1;
}

/**
 * Prune stale skipped message keys in-place.
 * Safe to call periodically — does not affect active chains.
 */
export function pruneSkippedInPlace(
  state: RatchetState,
  ttlMs = SKIP_KEY_TTL_MS,
  maxSize = MAX_SKIP,
): void {
  const now = Date.now();
  for (const [k, v] of state.skippedMessageKeys) {
    if (now - v.addedAt > ttlMs) state.skippedMessageKeys.delete(k);
  }
  // If still over limit, remove oldest entries first
  if (state.skippedMessageKeys.size > maxSize) {
    const sorted = [...state.skippedMessageKeys.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt);
    const toRemove = sorted.slice(0, state.skippedMessageKeys.size - maxSize);
    for (const [k] of toRemove) state.skippedMessageKeys.delete(k);
  }
}

export async function signFrame(payload: Bytes, sk: Bytes): Promise<string> {
  return toBase64(await sign(payload, sk));
}

export async function verifyFrameSig(
  payload: Bytes,
  sig: string,
  pk: string,
): Promise<boolean> {
  return verify(payload, fromBase64(sig), fromBase64(pk));
}
