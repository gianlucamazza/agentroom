# agentroom Protocol Specification

Version: **v2** (current). Backward-compatible with v1 (static DH sessions).

Source of truth for frame schemas: `packages/protocol/src/frames.ts` and `packages/protocol/src/schema.ts`.

---

## Transport

- WebSocket over `wss://` (TLS via optional cloudflared tunnel or reverse proxy)
- Single port handles both HTTP (auth) and WS (messaging) via `httpServer.on("upgrade")`
- WS endpoint: `GET /ws` — upgrade to WebSocket
- All frames are JSON-encoded UTF-8 strings

---

## Frame Envelope

Every frame (client→server and server→client) has this base:

```json
{
  "v": 2,
  "type": "<FrameType>",
  "msg_id": "<uuid-v4>",
  "ts": <unix-ms>
}
```

| Field    | Type     | Description                                           |
| -------- | -------- | ----------------------------------------------------- |
| `v`      | `1 \| 2` | Protocol version. v1 = static DH; v2 = Double Ratchet |
| `type`   | string   | Frame type (see below)                                |
| `msg_id` | string   | UUID-v4, unique per frame                             |
| `ts`     | number   | Client Unix timestamp (ms) — informational only       |

---

## Authentication

### 1. Challenge Request

```
GET /auth/challenge
→ 200 { "challenge": "<base64url-24-bytes>" }
→ 429 { "error": "too many requests" }       (rate limit: 10/min/IP)
```

### 2. HELLO frame (client → server)

```json
{
  "v": 2, "type": "HELLO", "msg_id": "...", "ts": ...,
  "ed25519_pk": "<base64url>",
  "x25519_pk":  "<base64url>",
  "challenge":  "<base64url-from-step-1>",
  "sig":        "<base64url: sign(challenge_bytes, ed25519_sk)>"
}
```

Server verifies the Ed25519 signature over the raw challenge bytes.

### 3. HELLO_ACK (server → client)

```json
{ "v": 2, "type": "HELLO_ACK", "msg_id": "...", "ts": ..., "session_token": "<jwt-like>" }
```

`session_token` format: `base64url(jti.ed25519_pk.timestamp_ms).hmac-sha256`.
Valid for 1 hour. Sent on reconnect (header, see below) to skip HELLO.

### Fast Reconnect

```
GET /ws
Authorization: Bearer <session_token>
```

The token travels in the `Authorization` header so it never lands in proxy or
tunnel access logs. The legacy `GET /ws?token=<session_token>` query-param form
is still accepted for pre-1.16 clients and will be removed in a future release.

Server validates the HMAC and token age (tokens are stateless — there is no
revocation table; rotation of `HMAC_SECRET` invalidates all tokens, and
`HMAC_SECRET_PREVIOUS` opens a dual-key window during rotation) and restores
the session without a challenge round-trip.
If token invalid/expired: server sends `ERROR { code: "UNAUTH" }` → client falls back to full HELLO.
After a token-auth open the client sends an app-level `PING`; the `PONG` (or
the `UNAUTH` error) settles the resume immediately instead of waiting for the
server's first keepalive.

---

## Invite System

### INVITE_PUBLISH (client → server)

```json
{
  "v": 2, "type": "INVITE_PUBLISH", "msg_id": "...", "ts": ...,
  "invite_id": "<uuid-v4>",
  "blob": "<base64url: JSON-encoded SignedInviteBlob>",
  "expires_at": <unix-ms>
}
```

`SignedInviteBlob` structure (inside `blob`):

```json
{
  "blob": {
    "invite_id": "...",
    "inviter_ed25519_pk": "<base64url>",
    "inviter_x25519_pk": "<base64url>",
    "nonce": "<base64url-16-bytes>",
    "server_url": "wss://...",
    "expires_at": <unix-ms>
  },
  "sig": "<base64url: sign(canonical_json(blob), ed25519_sk)>"
}
```

Invite URL: `agentroom://invite/<base64url(JSON.stringify(SignedInviteBlob))>`.

> **Note**: `expires_at` is Unix **milliseconds** (`Date.now() + ttl_ms`), not seconds. Verification allows a 30s clock-skew grace period.

### INVITE_CLAIM (client → server)

```json
{
  "v": 2, "type": "INVITE_CLAIM", "msg_id": "...", "ts": ...,
  "invite_id": "<uuid>",
  "from": "<invitee ed25519_pk>",
  "ciphertext": "<base64url: SESSION_INIT payload>",
  "nonce": "<same as ciphertext for SESSION_INIT>",
  "sig": "<base64url: sign({from,to,seq:0,nonce}, ed25519_sk)>"
}
```

Server: marks invite as claimed (single-use), routes `SESSION_INIT` to inviter (or queues if offline).

---

## Session Bootstrap (X25519 DH)

```
Invitee                         Server (blind relay)          Inviter
  │                                    │                          │
  │ INVITE_CLAIM {from, ciphertext}    │                          │
  │──────────────────────────────────► │                          │
  │                                    │  DELIVERY {SESSION_INIT} │
  │                                    │─────────────────────────►│
  │                                    │                          │ (derive keys)
  │                                    │  SESSION_ACK             │
  │ DELIVERY {SESSION_ACK}             │◄─────────────────────────│
  │◄───────────────────────────────────│                          │
```

**Key derivation (both sides)**:

```
shared = X25519(our_dh_sk, their_dh_pk)
salt   = invite_nonce (16 random bytes, agreed via invite blob)
keyA   = KDF(shared, salt, "agentroom-v1-keyA", 32)
keyB   = KDF(shared, salt, "agentroom-v1-keyB", 32)

inviter:  sendKey = keyA,  recvKey = keyB
invitee:  sendKey = keyB,  recvKey = keyA
```

> **Actual primitives.** `KDF` is an extract-and-expand construction over keyed
> BLAKE2b (libsodium `crypto_generichash`) — HKDF-shaped but **not** RFC 5869
> HKDF-SHA256. The AEAD used throughout is **XSalsa20-Poly1305** (libsodium
> `crypto_secretbox`, 24-byte nonce). Both are sound, widely deployed libsodium
> constructions; the v1/v2 wire format is **frozen** on them. A future protocol
> v3 may migrate to RFC 5869 HKDF and XChaCha20-Poly1305, but only behind a
> version bump — never as an in-place swap.

---

## Messaging (MSG frame)

```json
{
  "v": 2, "type": "MSG", "msg_id": "...", "ts": ...,
  "from": "<ed25519_pk>",
  "to":   "<ed25519_pk>",
  "ciphertext": "<base64url: XSalsa20-Poly1305 (crypto_secretbox) ciphertext>",
  "nonce":      "<base64url: 24-byte random nonce>",
  "sig":        "<base64url: sign({from,to,seq,nonce}, ed25519_sk)>",
  "seq":        <integer, monotonic per direction>,
  "ratchet_pk": "<base64url: sender X25519 ephemeral pk>"  // v2 only
}
```

Server verifies `from == authenticated_pk`, routes to recipient or queues.

---

## Double Ratchet (v2)

### Symmetric Ratchet (every message)

```
msgKey      = KDF(sendChainKey, seq)          // per-message key
ciphertext  = AEAD(plaintext, nonce, msgKey)
sendChainKey = KDF(sendChainKey, msgKey)      // advance chain (forward secrecy)
```

Old keys are discarded after use — prior messages cannot be decrypted with current state.

### DH Ratchet (post-compromise security)

The session is **seeded at the handshake**: each side sets its send ephemeral to its own
static x25519 keypair and `recvEphemeralPk` to the peer's static x25519 pub (both already
known from the invite). Exactly one side — the inviter — is flagged to initiate
(`needsSendDhStep`), so the first DH step is one-sided and rotation stays strictly
alternating (no concurrent-rotation desync).

**Send step** — performed on the first send after adopting the peer's latest ephemeral
(`needsSendDhStep` set by a recv step):

```
newSendEph     = generateKeypair()                              // fresh X25519 ephemeral
sendChainKey   = KDF(sendChainKey, X25519(newSendEph_sk, recvEphemeralPk))
ratchet_pk     = newSendEph.x25519_pk                           // advertised on the frame
```

**Recv step** — performed when an inbound `ratchet_pk` differs from the stored one:

```
recvChainKey   = KDF(recvChainKey, X25519(our_current_sendEph_sk, new_ratchet_pk))
recvEphemeralPk = new_ratchet_pk
recvSeq        = -1                                             // new chain, counter resets
needsSendDhStep = true                                          // our next send rotates
```

X25519 symmetry makes the send and recv derivations agree. The ratchet turns once per
conversational turn-around, so a one-time key compromise heals after the next exchange in
each direction. Frames carry no previous-chain-length (PN), so a prior-chain message that
arrives _after_ a rotation is not recoverable (rare with in-order transport).

### Out-of-order delivery

Keys for skipped messages are stored in `skippedMessageKeys: Map<"ratchet_pk:seq", key>` with a 5-minute TTL and max 100 entries per session. These are persisted to disk with the session state.

### Replay protection

`decryptMessage` rejects frames with `seq <= recvSeq` (per-chain counter). Counter resets to -1 on DH ratchet step (each chain is independent).

---

## Server-side frames

### ACK (server → sender)

```json
{
  "v": 2, "type": "ACK", "msg_id": "...", "ts": ...,
  "ref_msg_id": "<msg_id of the frame being acknowledged>",
  "status": "delivered" | "queued" | "error",
  "error": "<string>"  // only when status=error
}
```

### DELIVERY (server → recipient)

```json
{
  "v": 2, "type": "DELIVERY", "msg_id": "...", "ts": ...,
  "routed": { /* RoutedFrame */ }
}
```

### ERROR

```json
{
  "v": 2, "type": "ERROR", "msg_id": "...", "ts": ...,
  "code": "UNAUTH" | "INVALID_CHALLENGE" | "INVALID_SIG" | "NOT_FOUND" |
          "ALREADY_CLAIMED" | "EXPIRED" | "INVITE_QUOTA" | "RATE_LIMIT" |
          "BAD_JSON" | "BAD_FRAME" | "UNKNOWN_TYPE",
  "message": "<human-readable string>"
}
```

### PING / PONG

```json
{ "v": 2, "type": "PING", "msg_id": "...", "ts": ... }
{ "v": 2, "type": "PONG", "msg_id": "...", "ts": ... }
```

Server sends PING every 30s. Client echoes PONG. Keepalive only.

---

## Version Compatibility

| Field                     | v1              | v2                            |
| ------------------------- | --------------- | ----------------------------- |
| `v`                       | `1`             | `2`                           |
| DH ratchet (`ratchet_pk`) | absent          | present on MSG                |
| Session bootstrap         | static DH only  | static DH + symmetric ratchet |
| Forward secrecy           | per-session key | per-message key               |

v2 frames with `ratchet_pk` absent are treated as v1 (symmetric ratchet only, no DH step).

---

## Rate Limits & Resource Caps (server defaults)

| What                      | Limit                           | Scope            | Env override         |
| ------------------------- | ------------------------------- | ---------------- | -------------------- |
| `GET /auth/challenge`     | 10/min                          | per IP           | —                    |
| HELLO failures            | 5/min                           | per IP           | —                    |
| Post-auth frames          | 60/min sustained, burst 120     | per pk           | —                    |
| WS frame size             | 256 KiB (close 1009)            | per frame        | `WS_MAX_PAYLOAD`     |
| Concurrent WS connections | 500 (HTTP 503 on upgrade)       | per server       | `MAX_CONNECTIONS`    |
| Pending queue             | 500 messages                    | per recipient pk | `MAX_PENDING_MSGS`   |
| Unclaimed invites         | 20 (`INVITE_QUOTA` error)       | per inviter pk   | `MAX_INVITES_PER_PK` |
| Invite `expires_at`       | clamped to now + 7 days         | per invite       | —                    |
| Delivery backpressure     | queue past 1 MiB bufferedAmount | per recipient ws | —                    |

Schema field bounds: keys/sigs/nonces ≤ 512 chars, invite `blob` ≤ 16 KiB,
`ciphertext` ≤ 192 KiB, `challenge` ≤ 256, `error`/`message` ≤ 1 KiB.

Override: `RATE_LIMIT_DISABLED=1` disables the token-bucket limits (tests only);
size caps and quotas stay active.
