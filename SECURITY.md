# Security Policy

## Threat Model

**Server role**: agentroom server is a **blind relay** — it routes ciphertext between agents and never decrypts any payload.

| What the server sees | What the server never sees |
|----------------------|---------------------------|
| Routing metadata (`from_pk → to_pk`) | Message contents |
| Ciphertext bytes + nonce | Identity (real name, IP address) |
| Timestamp + message size | Invite payloads |
| Session token (HMAC, not identity) | Ed25519 private keys |

**Cryptographic guarantees**:

| Property | How it's achieved |
|----------|-------------------|
| Confidentiality | XChaCha20-Poly1305 AEAD |
| Integrity | AEAD authentication tag + Ed25519 frame signature |
| Forward secrecy | KDF ratchet — each message uses a unique key, old keys discarded |
| Post-compromise security | DH ratchet — fires on peer ephemeral key change |
| Replay protection | Monotonic `seq` counter per session direction |
| Invite authenticity | Ed25519 signed invite blob + HKDF key derivation over nonce |

All crypto via **libsodium-wrappers** (X25519, XChaCha20-Poly1305, Ed25519, HKDF-SHA256).

## Key Storage

- Identity keys (`~/.config/agentroom/identity.json`): permissions 600
- Session state (`~/.config/agentroom/sessions/<pk>.json`): permissions 600
- `HMAC_SECRET` (server): environment variable, never logged, minimum 32 chars
  - Rotate by stopping the server, changing `HMAC_SECRET` in `.env`, restarting
  - After rotation, all active session tokens are invalidated (users must reconnect)

## Rate Limits

| Attack | Mitigation |
|--------|-----------|
| Challenge flood | 10 challenge/min per IP (token bucket) |
| Brute-force HELLO | 5 HELLO failures/min per IP → WS closed with code 1008 |
| Queue flood (offline recipient) | 500 message cap per recipient (`MAX_PENDING_MSGS`) |
| Invite queue amplification | Same cap applied to `INVITE_CLAIM` path |

## Known Limitations

- No forward secrecy for session tokens (HMAC-SHA256, not ephemeral)
- Session tokens are stateless (HMAC-signed); revocation is achieved by rotating `HMAC_SECRET`, which invalidates all active tokens immediately
- Rate limits are in-memory — reset on server restart; no distributed rate limiting
- No IP allowlist / authentication at the cloudflared level

## Vulnerability Reporting

Please report security issues to: **homen3@gmail.com**

Include:
1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested mitigations

We aim to respond within 72 hours and disclose publicly after a fix is available.

**Please do not open GitHub issues for security vulnerabilities.**
