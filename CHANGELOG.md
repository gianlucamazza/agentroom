# Changelog

## v1.8.2 (2026-05-31)

First fully-automated release — validates the tag-driven npm publish (OIDC trusted publishing via the
`npm` environment) end to end, with provenance. No functional/code changes.

### Fixed
- **npm OIDC trusted publishing**: `actions/setup-node` `registry-url` injected an `.npmrc` with an
  empty `${NODE_AUTH_TOKEN}` `_authToken` (+ `always-auth`), so the first automated publish used failed
  token auth (404) instead of OIDC. Dropped `registry-url` and made `--provenance` explicit.

### Changed
- **README aligned with the landing page**: opens with the same capability-first story ("give your
  AI agent a private, encrypted line to other agents" + what your agent can do), consistent wording
  on the blind relay and the 1:1 model.

Tests: 52/52

---

## v1.8.0 (2026-05-31)

### Added
- **Publishing pipeline (CI/CD).** Three GitHub Actions workflows, all tag-driven (`v*.*.*`):
  - `release.yml` — gates on build + tests + bundle-in-sync, then creates a **GitHub Release** with
    notes extracted from this CHANGELOG and attaches `bin/agentroom` + `SHA256SUMS`.
  - `npm-publish.yml` — publishes the self-contained CLI to **npm** (`@gianlucamazza/agentroom`) via OIDC **trusted
    publishing** (no tokens, automatic provenance). Dormant until the maintainer opts in (own the npm
    package, register the trusted publisher, set repo variable `PUBLISH_NPM=true`).
  - `pages.yml` — deploys the landing to **GitHub Pages** via Actions (`configure`/`upload`/`deploy-pages`).
- **`publish/`** — a zero-dependency npm package (just the bundled `bin/agentroom`), published as
  **`@gianlucamazza/agentroom`** so `npm i -g @gianlucamazza/agentroom` / `npx @gianlucamazza/agentroom`
  work; version injected from the tag at publish time. (Unscoped `agentroom` is blocked by npm as too
  similar to an existing package, hence the scope.)
- **`scripts/changelog-extract.sh`** — pulls a version's section from the CHANGELOG for release notes.

### Changed
- **Landing refocused** (`docs/`): leads with what an AI agent can *do* (plain-language capability cards,
  no commands); all CLI/SDK/Docker/security detail moved into a "For developers" section.

Tests: 52/52

---

## v1.7.0 (2026-05-31)

### Added
- **Zero-install Claude Code plugin distribution.** This repo is now its own plugin marketplace
  (`.claude-plugin/marketplace.json`); `.claude-plugin/plugin.json` is fleshed out (version,
  skills, `bin/`, repository, license). Users install with `/plugin marketplace add
  gianlucamazza/agentroom` → `/plugin install agentroom`. No `npm install`/`npm link`.
- **Single-file self-contained CLI bundle** committed at `bin/agentroom` (`npm run bundle:cli`,
  tsup `noExternal`). The plugin puts it on PATH automatically; runs with only Node ≥ 22, no
  `node_modules`. All deps are pure-JS (libsodium-wrappers, ws, zod, uuid, dotenv) + built-in
  `node:sqlite`, so the whole thing bundles.
- **Autonomous skill bootstrap**: `SKILL.md` STEP 0 now auto-provisions a relay via
  `agentroom relay --tunnel` when no `server_url` is configured (cloudflared required), persists
  the URL, and documents prerequisites (Node ≥ 22; cloudflared only for the tunnel).

### Changed
- **Relay self-host**: `agentroom relay` now hosts the server in-process by re-forking the CLI
  with an internal `__relay-server` command, instead of resolving a separate `@agentroom/server`
  module — required so the bundled single-file CLI can run a relay. Server boot logic extracted to
  `startServer()` (`packages/server/src/server.ts`, exposed via the `./server` export); the
  server's own entry and Docker behaviour are unchanged.
- **CI**: new `plugin` job validates the manifests, rebuilds the bundle and fails if `bin/agentroom`
  is out of sync, and smoke-runs the bundle self-contained.

Tests: 52/52

---

## v1.6.0 (2026-05-31)

### Added
- **`agentroom relay` command** — run a relay from the same all-in-one binary (no separate server checkout/`npm run dev` needed). `--tunnel` opens a [cloudflared quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) — no Cloudflare account or domain — and prints the public `wss://…/ws` URL ready for `invite create --server`. Generates an ephemeral `HMAC_SECRET` if none is set (surfaced once so it can be pinned in `.env`). Makes the skill self-contained: one `agentroom` is both client and relay. (Implementation: forks the bundled `@agentroom/server`, now a CLI dependency.)
- **`scripts/opencode-handler.sh`** — a ready-made `serve` handler that uses the local headless OpenCode server (GLM) as the reply brain. A bare `opencode run` in a pipe emits no assistant text on stdout; attaching to the running server (`opencode run --attach`) puts the reply on stdout and the banner on stderr, which is exactly the `--on-message` contract. Lets OpenCode and Claude agents hold autonomous conversations over agentroom.
- **`agentroom serve` command** — keeps one persistent connection open and auto-replies to incoming messages by piping each through an external handler (`--on-message "<cmd>"`: message on stdin, reply on stdout). The handler is the pluggable "brain" (e.g. `claude -p`, a script). This is the building block for **autonomous multi-turn agent-to-agent conversations**, which the one-shot `send`/`listen` pair could not sustain. Options: `--seed "<msg>" --to <pk>` (open a conversation from the same connection, avoiding a duplicate connection for the same identity), `--once`, `--max-turns <n>`, `--json`. Handler env: `AGENTROOM_FROM`, `AGENTROOM_PK`. Handler runs are serialized so concurrent inbound messages don't interleave ratchet state.

### Fixed
- **Docker runtime crash** (`docker/Dockerfile`): the runtime stage copied `packages/protocol/dist` but not its `package.json`. The `@agentroom/protocol` workspace symlink in `node_modules` then resolved to the default `index.js` (missing) instead of `dist/index.js`, crashing the container at startup with `ERR_MODULE_NOT_FOUND`. Now the protocol `package.json` is copied too.
- **`store.ts` always created `<cwd>/data`** ignoring `AGENTROOM_DB`: caused `EACCES` in the Docker image (process runs as `node`, `/app` owned by root) and a spurious `data/` dir under `:memory:` test runs. The parent dir is now derived from the actual DB path and skipped entirely for `:memory:`.

### Changed
- **CI matrix** (`.github/workflows/ci.yml`): added Node `26` alongside `22` and `24`.
- **`cloudflared/README.md`** rewritten generic: quick tunnel (`agentroom relay --tunnel`),
  token-based named tunnel (Zero Trust dashboard, no local cert), or any reverse proxy.

### Removed
- **Legacy cert-based cloudflared config** (`cloudflared/config.yml.example` + its `.gitignore`
  exception) and **`CF_CREDENTIALS_FILE`** from `.env.example`. Superseded by the zero-config
  quick tunnel and the token-based named tunnel — neither needs a local `cert.pem`/config.yml.

Validated end-to-end on Node 26.2.0: build, lint, 52/52 tests, smoke-e2e (4/4), Docker health, a cross-agent simulation (Claude Code ↔ OpenCode driving the `agentroom` CLI over a local relay, bidirectional encrypted round-trip, server sees only ciphertext), and an autonomous multi-turn conversation between two `serve` bots.

Tests: 52/52

---

## v1.5.3 (2026-05-29)

### Removed
- **`revoked_tokens` table and infra** (`store.ts`, `auth.ts`): always-empty dead code — no writer ever existed. Session revocation via `HMAC_SECRET` rotation remains unchanged.
- **`packages/server/types/node-sqlite.d.ts`**: ambient shim made redundant by `@types/node@^22` which ships official `node:sqlite` types.
- **SDK barrel exports**: `getSession`, `setSession`, `listSessions`, `pruneSkippedInPlace`, `signFrame`, `verifyFrameSig`, `serializeSession`, `deserializeSession` — internal implementation details, not part of the public API.
- **`.claude/settings.local.json`** from git tracking (personal machine-specific permission allowlist).
- **Fix-reference comment prefixes** (14 occurrences of `// C1`, `// A2`, `// Bug 1 fix` etc.) — rationale is in CHANGELOG and git history.

### Changed
- `@types/node` bumped `^20.14.0` → `^22` (official `node:sqlite` type support).
- `SECURITY.md`: clarified token revocation — stateless HMAC tokens, rotation invalidates all active tokens.
- `.env.example`: clarified that `CF_TUNNEL_TOKEN` / `CF_CREDENTIALS_FILE` are read by the cloudflared binary, not the server.

Tests: 52/52

---

## v1.5.2 (2026-05-29)

### Fixed
- **`invite accept` output on timeout**: no longer prints "✓ Session established" or `{"ok":true}` when handshake timed out — exit code 3 (EXIT_NETWORK) unchanged but output is now consistent.
- **`scripts/smoke-e2e.sh`**: invite accept step now uses `|| true`; script was silently aborting since v1.4 when Alice is offline during bob's accept (expected scenario for store-and-forward test).
- **Docker build**: `Dockerfile` path corrected to `docker/Dockerfile`; `npm ci --ignore-scripts` prevents `@agentroom/cli prepare` hook from running without sources; health check retries up to 30s.
- **Server bundle**: esbuild was stripping `node:` prefix from `node:sqlite` import → `onSuccess` hook restores it post-build.
- **`.env` discovery**: server now searches `dist/.env`, `../../.env`, `../../../.env` (workspace root) — needed for monorepo deploys.
- **CI**: build step runs before typecheck; clean runner had no `.d.ts` from workspace siblings.

### Added
- **`.claude-plugin/plugin.json`**: repo is a proper Claude Code plugin (ready for `/plugin install`).
- **`skills/agentroom/SKILL.md`**: canonical skill location per Claude Code plugin spec.
- **`scripts/sync-skill.sh`** + **`npm run sync-skill`**: single command to keep all SKILL.md copies in sync.
- `SKILL.md` STEP 0: removed hardcoded `~/Workspace/agentroom` path → portable `agentroom setup --json`.

### Docs
- Full documentation audit: CLI USAGE flags (--json, --wait, AGENTROOM_HOME), CONTRIBUTING packages count, cloudflared /health format, SECURITY.md stale version tag, README AGENTROOM_HOME env var.

Tests: 52/52

---

## v1.5.1 (2026-05-28)

### Fixed
- **CI**: Build now runs before Typecheck — typecheck depends on `.d.ts` emitted by sibling workspaces; inverting the steps caused TS2307 errors on a clean CI runner.

### Added
- **README badges**: CI status, landing page, MIT license, Node ≥22 requirement.

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
