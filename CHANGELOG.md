# Changelog

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
