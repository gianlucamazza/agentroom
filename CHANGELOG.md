# Changelog

## v1.5.1 (2026-05-28)

### Fixed
- **CI**: Build now runs before Typecheck — typecheck depends on `.d.ts` emitted by sibling workspaces; inverting the steps caused TS2307 errors on a clean CI runner.

### Added
- **README badges**: CI status, landing page, MIT license, Node ≥22 requirement.

### Docs
- Synced `.claude/skills/agentroom/SKILL.md` with root (`--no-probe`, `--wait`, `--json` were missing).
- CLI USAGE: added `--json` to `send`/`invite create`/`invite accept`, `--wait <s>` to `invite accept`, `AGENTROOM_HOME` env note to `setup`.
- `CONTRIBUTING.md`: packages count 3 → 4; removed specific model name from commit trailer example.
- `cloudflared/README.md`: fixed `/health` response example (added `db`/`agents`/`uptime_s` fields); updated step 5 to use `npm run setup` + `agentroom setup`.
- `SECURITY.md`: removed stale `(v1.2)` version tag from Known Limitations; updated token revocation status to reflect current implementation.
- `README.md`: landing page already live (URL in Develop section); added `AGENTROOM_HOME` to env vars table; added npm prefix note for Linux systems.

---

## v1.5.0 (2026-05-28)

### Added
- **Landing page** in `docs/` (GitHub Pages): HTML+CSS, no external deps, dark mode, copy buttons, mobile-friendly. Activate via repo Settings → Pages → Source: `main /docs`.
- **`agentroom setup`** command: one-shot bootstrap — generates `.env` with `HMAC_SECRET`, creates `data/`, initialises identity (`~/.config/agentroom/`). Flags: `--json`, `--force`, `--cwd`, `--home`.
- **`npm run setup`** root script: `npm install && npm run build && npm link -w @agentroom/cli` — onboarding one-shot for new contributors.
- **`engines.node >=22`** in all five `package.json` files — enforced at `npm install`.
- **`files: ["dist", "README.md"]`** in all four package manifests — ready for future `npm publish`.
- **`prepare` script** in `@agentroom/cli` — `npm install` from a git-source clone now auto-builds.

### Changed
- **`bin/agentroom-setup.sh`** delegates to `agentroom setup --json` when the CLI is in PATH; falls back to bash implementation for pre-install skill bootstrap.
- **README quickstart** split into three role-based flows: *Run a relay*, *Chat as a client*, *Develop*.

Tests: 52/52

---

## post-v1.4 (2026-05-28)

### Bug fixes
- **ws.ts race (A3 regression)**: close handler now checks `agents.get(pk)?.ws === ws` before deleting, preventing the new connection being removed when the old WS close event fires after `agents.set`.
- **routes.ts `/health`**: `store.countAgents()` called once inside try/catch, result reused in JSON — avoids crash on second call if DB goes down between checks.
- **metrics.ts**: `ws_connections` initialized to `0` at cold start so `/metrics` is consistent before any client connects.

### TypeScript
- Fixed `filter(Boolean)` to use type predicate `(a): a is string => Boolean(a)` in CLI index.ts.
- Fixed `Uint8Array` indexed access in session.test.ts (`noUncheckedIndexedAccess`).
- Added ambient declarations for `node:sqlite` in `packages/server/types/`.
- Fixed vitest.config.ts `ssr.external` cast for Vite typing constraint.

### Docs
- `CHANGELOG.md`: added v1.4 entry (was missing).
- `.env.example`: added `LOG_LEVEL`, `TRUST_PROXY`, `AGENTROOM_DB` (were documented in README but absent from example).
- `SKILL.md`: documented `--no-probe` flag for offline bootstrap and `--wait <s>` for invite accept.

---

## v1.4 (2026-05-28)

### CLI
- `agentroom --version` / `version` command
- `--json` output for all commands: `init`, `send`, `invite create`, `invite accept`
- `whoami` is now read-only (no longer creates identity silently)
- Exit codes: `EXIT_USAGE=2`, `EXIT_NETWORK=3`, `EXIT_NO_SESSION=4`, `EXIT_ERROR=1`
- `send`: message validated not to be a `--flag` (accidental flag-as-message)
- USAGE: `peers` line corrected (removed non-existent `--server` flag)

### Server
- `LOG_LEVEL` env var (`error`/`warn`/`info`, default `info`)
- Boot log includes active `log_level`

### Protocol
- `parseInviteUrl`: 30-second clock-skew grace period on `expires_at`
- `PROTOCOL.md`: `expires_at` units corrected to Unix ms

### Docs
- `CONTRIBUTING.md` added
- `README.md`: `LOG_LEVEL` in env vars table
- `PROTOCOL.md`: expires_at units + grace period documented

Tests: 52/52

---

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
