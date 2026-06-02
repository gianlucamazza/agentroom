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
// Model (Signal-style Double Ratchet):
//  • Each message advances the send/recv chain key: forward secrecy (symmetric ratchet).
//  • ratchet_pk carries the sender's current X25519 ephemeral pub.
//  • DH ratchet (post-compromise security): a side does a *send* DH step — generate a
//    fresh ephemeral, mix DH(newEph, peerEph) into the send chain — on its first send
//    after adopting a new peer ephemeral (needsSendDhStep). The peer performs the matching
//    *recv* DH step when it sees the changed ratchet_pk. So the ratchet turns once per
//    conversational turn-around, giving PCS at that granularity.
//
// Bootstrapping the alternation (no wire change): at session init both sides seed
// recvEphemeralPk = peer's static x25519 pub and sendEphemeral = own static identity
// keypair (both already known from the invite handshake), eliminating a "first contact"
// branch that would otherwise break send/recv symmetry. Exactly one side (the inviter)
// seeds needsSendDhStep=true, so the very first DH step is one-sided — this rules out the
// concurrent-rotation hazard (both sides ratcheting against each other's stale key).
//
// Legacy sessions (created before seeding, deserialized with needsSendDhStep=false and a
// random/absent ephemeral) never rotate: they keep working with symmetric forward secrecy
// only, no PCS. See SECURITY.md / PROTOCOL.md.
// ─────────────────────────────────────────────

export interface RatchetState {
  peerPk: string;

  sendChainKey: Bytes;
  recvChainKey: Bytes;

  // DH ratchet fields
  sendEphemeral: AgentKeypair;
  recvEphemeralPk: Bytes;  // peer's current ratchet ephemeral pub (seeded at init)

  sendSeq: number;
  recvSeq: number;

  /** True after a recv DH step: our next send must perform a send DH step (rotate ephemeral). */
  needsSendDhStep: boolean;

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
  recvEphemeralPk: string;
  sendSeq: number;
  recvSeq: number;
  needsSendDhStep: boolean;
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
    recvEphemeralPk: toBase64(state.recvEphemeralPk),
    sendSeq: state.sendSeq,
    recvSeq: state.recvSeq,
    needsSendDhStep: state.needsSendDhStep,
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
    recvEphemeralPk: fromBase64(s.recvEphemeralPk),
    sendSeq: s.sendSeq,
    recvSeq: s.recvSeq,
    needsSendDhStep: s.needsSendDhStep,
    skippedMessageKeys: skippedMap,
    lastUsedAt: s.lastUsedAt ?? Date.now(),
  };
}

const MAX_SKIP = 100;
const SKIP_KEY_TTL_MS = 5 * 60_000;

// ─────────────────────────────────────────────
// SessionStore — per-instance store (C4 fix)
// Eliminates module-level singleton that caused cross-client contamination.
// ─────────────────────────────────────────────

export class SessionStore {
  private map = new Map<string, RatchetState>();

  get(peerPk: string): RatchetState | undefined {
    return this.map.get(peerPk);
  }
  set(peerPk: string, state: RatchetState): void {
    this.map.set(peerPk, state);
  }
  has(peerPk: string): boolean {
    return this.map.has(peerPk);
  }
  list(): string[] {
    return [...this.map.keys()];
  }

  /**
   * Initialize a ratchet session, seeding the DH ratchet so post-compromise security
   * is active from the first message:
   *  - sendEphemeral = our static identity keypair (its x25519 pub is what the peer
   *    knows for us from the invite), recvEphemeralPk = peer's static x25519 pub.
   *    These mutually-known keys define the first DH ratchet pair, so send and recv
   *    derivations stay symmetric without an asymmetric "first contact" branch.
   *  - initiateRatchet=true on exactly ONE side (the inviter) seeds needsSendDhStep,
   *    so the first DH step is one-sided → strict alternation, no concurrent rotation.
   */
  async init(
    peerPk: string,
    bootstrapKeys: SessionKeys,
    seed: { identity: AgentKeypair; peerX25519Pk: Bytes; initiateRatchet: boolean },
  ): Promise<RatchetState> {
    const session: RatchetState = {
      peerPk,
      sendChainKey: bootstrapKeys.sendKey,
      recvChainKey: bootstrapKeys.recvKey,
      sendEphemeral: seed.identity,
      recvEphemeralPk: seed.peerX25519Pk,
      sendSeq: 0,
      recvSeq: -1,
      needsSendDhStep: seed.initiateRatchet,
      skippedMessageKeys: new Map(),
      lastUsedAt: Date.now(),
    };
    this.map.set(peerPk, session);
    return session;
  }
}

/** Encrypt a message, advancing the send chain (symmetric ratchet). */
export async function encryptMessage(
  session: RatchetState,
  plaintext: Bytes,
): Promise<{ ciphertext: string; nonce: string; ratchet_pk: string }> {
  // DH ratchet (post-compromise security): on the first send after we adopted a new
  // peer ephemeral, generate a fresh sending ephemeral and mix DH(newEph, peerEph) into
  // the send chain. The peer runs the matching recv DH step when it sees the changed
  // ratchet_pk. Only fires when seeded (needsSendDhStep) and we know the peer's current
  // ephemeral; strict alternation (single initiator) precludes concurrent rotation.
  if (session.needsSendDhStep && session.recvEphemeralPk !== null) {
    const newEph = await generateKeypair();
    const dhOut = await dhSharedSecret(newEph.x25519_sk, session.recvEphemeralPk);
    const { chainKey } = await ratchetStep(session.sendChainKey, dhOut);
    session.sendChainKey = chainKey;
    session.sendEphemeral = newEph;
    session.sendSeq = 0;
    session.needsSendDhStep = false;
  }

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
 * - Performs a recv DH ratchet step when the peer's ratchet_pk changes (post-compromise
 *   security): derives the new recv chain from DH(our current sending ephemeral, peer's
 *   new ephemeral) and flags our next send to rotate (needsSendDhStep).
 *
 * C3 fix: state mutations are rolled back if open() fails, preventing session corruption
 * on malformed/replayed messages.
 */
export async function decryptMessage(
  session: RatchetState,
  ciphertext: string,
  nonce: string,
  seq: number,
  ratchet_pk_b64?: string,
): Promise<Bytes> {
  // Check skipped message keys (out-of-order)
  const skipKey = `${ratchet_pk_b64 ?? ""}:${seq}`;
  const skipped = session.skippedMessageKeys.get(skipKey);
  if (skipped) {
    session.skippedMessageKeys.delete(skipKey);
    return open(fromBase64(ciphertext), fromBase64(nonce), skipped.key);
  }

  // ── Snapshot for rollback (C3 fix) ───────────────────────────────────────
  // State is mutated below (DH ratchet + chain advance). If open() fails,
  // we restore to pre-mutation state so the session remains functional.
  const snapshot = {
    recvChainKey:    session.recvChainKey,
    recvEphemeralPk: session.recvEphemeralPk,
    sendChainKey:    session.sendChainKey,
    sendEphemeral:   session.sendEphemeral,
    sendSeq:         session.sendSeq,
    recvSeq:         session.recvSeq,
    needsSendDhStep: session.needsSendDhStep,
  };

  try {
    // Recv DH ratchet step: the peer advertised a new ratchet_pk (its ephemeral rotated).
    if (ratchet_pk_b64) {
      const prevPkB64 = toBase64(session.recvEphemeralPk);
      if (ratchet_pk_b64 !== prevPkB64) {
        // NOTE: we do not drain leftover keys from the previous recv chain here — the
        // frame carries no "previous chain length" (PN), so messages from the prior chain
        // that arrive AFTER this rotation cannot be recovered (rare with in-order
        // transport). Skipped keys already buffered before the rotation stay retrievable.
        const newPeerPk = fromBase64(ratchet_pk_b64);
        // DH against OUR current sending ephemeral — the key the sender DH'd against.
        const dhOut = await dhSharedSecret(session.sendEphemeral.x25519_sk, newPeerPk);
        const { chainKey: newRecvChain } = await ratchetStep(session.recvChainKey, dhOut);
        session.recvChainKey = newRecvChain;
        session.recvEphemeralPk = newPeerPk;
        // Reset recv counter for the new chain
        session.recvSeq = -1;
        // Defer our own ephemeral rotation to the next send (lazy, keeps alternation strict).
        session.needsSendDhStep = true;
      }
    }

    // Replay check — AFTER the DH step so a rotation (which resets recvSeq for the new
    // chain) doesn't make a legitimate seq look like a replay of the previous chain.
    if (seq <= session.recvSeq) {
      throw new Error(`replay detected: seq ${seq} <= last seen ${session.recvSeq}`);
    }

    // Store skipped keys if seq > recvSeq + 1 (out-of-order: advance chain to seq)
    const peerPkForSkip = ratchet_pk_b64 ?? toBase64(session.recvEphemeralPk);
    if (seq > session.recvSeq + 1) {
      await storeSkippedKeys(session, peerPkForSkip, seq);
    }

    // Decrypt with current recv chain — this is the only step that can fail
    const msgKey = await messageKey(session.recvChainKey, seq);
    const plaintext = await open(fromBase64(ciphertext), fromBase64(nonce), msgKey);

    // open() succeeded: advance recv chain and commit
    const { chainKey: nextChainKey } = await ratchetStep(session.recvChainKey, msgKey);
    session.recvChainKey = nextChainKey;
    session.recvSeq = seq;
    session.lastUsedAt = Date.now();

    return plaintext;
  } catch (e) {
    // Rollback chain state — skippedMessageKeys mutations are intentionally kept
    session.recvChainKey    = snapshot.recvChainKey;
    session.recvEphemeralPk = snapshot.recvEphemeralPk;
    session.sendChainKey    = snapshot.sendChainKey;
    session.sendEphemeral   = snapshot.sendEphemeral;
    session.sendSeq         = snapshot.sendSeq;
    session.recvSeq         = snapshot.recvSeq;
    session.needsSendDhStep = snapshot.needsSendDhStep;
    throw e;
  }
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
  if (count === MAX_SKIP && upToSeq - startSeq > MAX_SKIP) {
    console.warn(`[agentroom] skipping ${upToSeq - startSeq - MAX_SKIP} out-of-order messages (exceed MAX_SKIP=${MAX_SKIP})`);
  }
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
