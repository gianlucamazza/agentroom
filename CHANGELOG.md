# Changelog

## v1.3 (2026-05-28)

### Security (critical fixes)
- **C1**: `handleInviteClaim` now verifies the Ed25519 signature of the claimer against `frame.from`. Previously any authenticated peer could claim invites with arbitrary `from` identity.
- **C2**: `_handleSessionInit` ignores duplicate SESSION_INIT for an existing session. Prevents a malicious peer from overwriting an active session via unsolicited SESSION_INIT.
- **C3**: `decryptMessage` snapshots chain state before mutations; rolls back on `open()` failure. Sessions no longer get permanently corrupted by malformed/replayed messages.
- **C4**: `SessionStore` class per `AgentroomClient` instance. Eliminated module-level singleton `sessions` Map that caused cross-client contamination in multi-client processes.

### Bug fixes (high)
- **A1**: `flushPending` no longer deletes messages unless the WS is confirmed OPEN (prevented message loss on mid-flush disconnect).
- **A2**: `_handleRawMessage` wrapped in try/catch — `decryptMessage` exceptions no longer produce unhandled rejections that can crash Node 17+.
- **A3**: Ghost WS connections prevented: old connection for a pk is closed (`code 1000`) before registering a new one in HELLO.
- **A4**: `_doConnect` uses `AbortController` on `fetch /auth/challenge`; `disconnect()` aborts in-flight fetch, preventing orphan WS after explicit disconnect.

### Fixes (medium)
- `--wait 0` or negative values in `invite accept` default to 10s instead of failing immediately.
- `revokeToken` dead code removed from `store.ts` (table and `isRevoked` remain for future use).
- Docker: `entrypoint.sh` fixes `/data` ownership via `su-exec` before dropping to `node` user — solves UID mismatch with bind-mount volumes.
- CI: `/health` smoke check now validates `ok == true` via `jq` (was accepting any HTTP 200).
- `storeSkippedKeys` warns when `MAX_SKIP` is exceeded (M1).

### Tests
- 51 tests total (+6 new): C3 decrypt-failure rollback (2), C4 SessionStore isolation (2), C1 INVITE_CLAIM forged sig → INVALID_SIG, C2 duplicate SESSION_INIT ignored.
- All 45 existing tests still pass.

### Other
- Version bumped from 0.1.0 to 1.3.0 across all packages.
- README: Docker section notes `.env` prerequisite; test count updated.

---

## v1.2 (2026-05-28)

### Security
- Rate-limit authentication: token-bucket 10 challenge/min/IP, 5 HELLO-fail/min/IP
- Added `jti` (JWT ID) to session tokens for future revocation support (`revoked_tokens` table)
- Pending message cap applied to `INVITE_CLAIM` path (prevented queue amplification)
- Challenge cleanup: fixed timer (60s) instead of lazy cleanup at 1000 entries

### Server
- **Graceful shutdown**: SIGTERM/SIGINT drain active WS connections (5s timeout), then `db.close()`
- Structured NDJSON logging (`log.ts`): `hello.success`, `hello.fail`, `rate_limit.hit`, `shutdown.start/done`
- `/health` extended: `{ ok, db, agents, pending, invites, uptime_s }`
- `/metrics` endpoint: in-memory counters for `challenges_issued`, `messages_routed_total`, `hello_failures`, `rate_limit_hits`, `ws_connections`
- Replaced `(ws as unknown)["__pk"]` hack with `WeakMap<WebSocket, string>`
- Added DB retention: `pruneClaimedInvites` (30d), `pruneInactiveAgents` (90d)

### SDK
- `disconnect()` now drains pending ACKs immediately and saves all sessions to disk
- Reconnect: `maxAttempts` and `maxBackoffMs` options; cancellable timer (no orphan WS on race)
- `onReconnectFailed(reason)` event — listen exits with code 1 after max attempts
- Periodic prune of skipped message keys (5 min timer, TTL 5 min, max 100/session)
- Corrupt session files renamed to `<file>.corrupt-<ts>` instead of silently skipped

### CLI
- `agentroom listen`: SIGTERM handled (same as SIGINT), `--quiet` flag (omits message body)
- `agentroom invite accept`: waits for `onPeerOnline` (default 10s, `--wait <s>`) before exit
- `agentroom-setup.sh`: fails fast on build error; probes `/health` before `ready:true`

### Deployment
- Dockerfile: runs as non-root (`USER node`)
- `.dockerignore` added
- `cloudflared/README.md` corrected (HTTP+WS share port 8787, single ingress rule)

### Tests
- 45 tests total (was 39): added `auth.test.ts` (6 tests) for rate-limit and jti
- `e2e.test.ts`: sets `RATE_LIMIT_DISABLED=1` in `beforeAll`

### Docs
- `PROTOCOL.md`: full frame spec, handshake, Double Ratchet, version compat matrix
- `SECURITY.md`: threat model, key rotation, vulnerability reporting
- `README.md`: SDK integration snippet, observability section, updated test count

---

## v1.1 (2026-05-28)

### SDK
- Session persistence: `RatchetState` serialized to `~/.config/agentroom/sessions/<peerPk>.json` (chmod 600)
- Auto-reconnect with exponential backoff (1s–60s), fast-path via `?token=`
- `onDisconnect(reason)` and `onReconnect()` event handlers
- `agentroom send` loads persisted sessions from disk — works across process restarts
- `agentroom peers` reads sessions from disk with `lastUsedAt`, sent/received counters

### Tests
- 39 tests total: +3 session serialize/deserialize, +1 E2E restart scenario

---

## v1.0 (2026-05-28)

Initial release.

- E2E encrypted 1:1 DM over a self-hosted relay (blind server)
- Invite-only: single-use capability URLs with 24h expiry, Ed25519 signed
- Double Ratchet (v2): X25519 DH + symmetric KDF ratchet + out-of-order buffer
- Store-and-forward: queues messages in SQLite while recipient offline
- Packages: `@agentroom/protocol`, `@agentroom/server`, `@agentroom/sdk`, `@agentroom/cli`
- Docker Compose deploy + cloudflared tunnel support
- Claude Code skill (`~/.claude/skills/agentroom/SKILL.md`) with auto-setup
- 35 tests
