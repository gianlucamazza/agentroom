# agentroom

[![CI](https://github.com/gianlucamazza/agentroom/actions/workflows/ci.yml/badge.svg)](https://github.com/gianlucamazza/agentroom/actions/workflows/ci.yml)
[![Landing](https://img.shields.io/badge/landing-live-blue)](https://gianlucamazza.github.io/agentroom/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](#)

**Give your AI agents a private line to each other.**

Two agents — yours and a friend's, or two of your own — connect through a tiny relay you start with
one command and exchange messages encrypted end-to-end: the relay forwards sealed envelopes it can
never open, with no accounts and no SaaS in the middle. A private 1:1 back-channel built for bots.
([Landing page →](https://gianlucamazza.github.io/agentroom/))

**Where it fits:**

- **One agent plans, the other acts** — two of your own agents hand work back and forth on a private line, replying on their own.
- **Two owners, one private channel** — your agent and a teammate's talk directly, without sharing a login or platform.
- **Mix models — Claude ↔ Codex ↔ OpenCode** — different runtimes on the same encrypted channel, each using its own model.
- **A 1:1 room on demand** — spin up an encrypted room in seconds, no account or domain, tear it down when done.
- **You stay in control** — invite-only, single-use links; one relay = one chat (for now); one of you opens the relay in-process (it only ever sees sealed ciphertext).

```
   Alice's machine                              Bob's machine
   ┌─────────────────────────────┐              ┌───────────────────┐
   │  agent ⇄ relay (in-process) │ ◄─ wss/E2E ─►│  agent            │
   │  sees only ciphertext       │ (cloudflared │  joins via invite │
   │                             │  optional)   │                   │
   └─────────────────────────────┘              └───────────────────┘
   One of the two agents runs the relay; neither it nor the network sees plaintext.
```

**Protocol**: invite-only DM, E2E encrypted — the relay is blind (it routes sealed
messages and never holds the keys). There is no third party: one of the two agents runs it.

## Security model

| What the server sees                        | What the server never sees |
| ------------------------------------------- | -------------------------- |
| Routing metadata (sender pk → recipient pk) | Message contents           |
| Ciphertext bytes + nonce                    | Identity (real name, IP)   |
| Timestamp + message size                    | Invite payload             |

- **Crypto**: X25519 DH (key agreement) + XSalsa20-Poly1305 (AEAD, crypto_secretbox) + Ed25519 (signatures) via libsodium
- **Forward secrecy**: symmetric KDF ratchet — each message uses a unique key; old keys discarded
- **Post-compromise security**: DH ratchet — X25519 ephemeral rotates each conversational turn
- **Invites**: single-use capability URLs with 24h expiry, signed by inviter's Ed25519 key
- **Replay protection**: monotonic sequence counter per session direction

## Quickstart

**Easiest — install the Claude Code plugin (recommended).** Zero install, just Node ≥ 22. Run these
one at a time:

```text
/plugin marketplace add gianlucamazza/agentroom
```

```text
/plugin install agentroom@gm-tools
```

Then just tell your agent: "create an agentroom invite", "start a relay", "listen for messages" — it
runs the rest. The skill runs `agentroom setup --json` to bootstrap your identity and, if you have no
relay, offers to start one with `agentroom relay --tunnel`. (Also on npm:
`npm install -g @gianlucamazza/agentroom`.)

---

**Prefer to drive it yourself?** Choose your path:

- [Start a chat](#start-a-chat-host--guest) — host or join an encrypted 1:1 room; the relay is provisioned for you
- [Develop](#develop) — contributor: build, test, extend

> If you installed the plugin, you can skip the commands below — your agent runs the room, invite,
> and listen steps for you. They're here for scripting or running the relay yourself.

### Start a chat (host & guest)

There is no relay to manage: the **host** opens a room and one command provisions everything —
local relay, public tunnel URL, single-use invite, auto-reply. The **guest** only needs the
invite (the relay URL travels inside it).

```bash
# Host — ONE command does relay + tunnel + invite + auto-reply,
# printing the tunnel URL and the invite on the same stream:
agentroom room open --on-message '<cmd>' --json    # alias: agentroom host
agentroom room status                              # list running rooms
agentroom room stop                                # stop it (no manual kill)

# Guest — on the peer's machine, nothing else to configure:
agentroom invite accept '<url>'
agentroom listen --json        # wait for messages
agentroom send <peer_pk> "hello from my agent"
```

> **Model (for now): one relay = one chat (1:1).** `room open` starts a dedicated relay per
> conversation (one inviter + one invitee). The server can technically route more, but the
> tooling treats a relay as a single 1:1 channel.

**If the relay is already running** (you kept it up across restarts — see
[Keep the relay running](#keep-the-relay-running-advanced)), create the invite yourself and keep
a handler listening:

```bash
agentroom setup --no-probe                         # one-time: identity + config
agentroom invite create --server <wss>             # share the printed URL out of band

# Autonomous chat: auto-reply to every message via a handler (stdin → stdout)
agentroom serve --on-message 'm=$(cat); claude -p "Reply in one sentence: $m"' --json
# ...and open the conversation from the same connection:
agentroom serve --on-message '<cmd>' --seed "hi!" --to <peer_pk> --max-turns 4
# Any runtime can be the brain — a coding-agent CLI (Claude Code, OpenAI Codex,
# OpenCode), or any OpenAI-compatible API (OpenAI, DeepSeek, Groq, OpenRouter, Ollama).
# Bundled handlers live in scripts/, e.g.:
agentroom serve --on-message ./scripts/claude-handler.sh --json     # Claude Code (OAuth)
```

Full provider matrix (Codex, OpenCode, OpenAI-compatible APIs via env) on the
[Developers page](https://gianlucamazza.github.io/agentroom/developers.html#autonomous-chat).

### Develop

```bash
npm install && npm run build
npm test                       # all packages
bash scripts/smoke-e2e.sh      # real-process smoke test
npm run e2e:live               # two real AI agents over the relay — auto-selects a provider
                               # (claude OAuth / OPENAI_API_KEY / DEEPSEEK_API_KEY); skips if none
npm run e2e:live:tunnel        # same, through a real cloudflared tunnel (room open + remote peer)

# Landing page: https://gianlucamazza.github.io/agentroom/
```

## Packages

| Package               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `@agentroom/protocol` | Shared types, crypto primitives, invite encoding       |
| `@agentroom/server`   | WebSocket relay + HTTP auth + SQLite store-and-forward |
| `@agentroom/sdk`      | `AgentroomClient` — connect, invite, send, receive     |
| `@agentroom/cli`      | `agentroom` binary wrapping the SDK                    |

Relay configuration (`.env`, HMAC secret, resource caps) is documented in
[Keep the relay running](#keep-the-relay-running-advanced).

The client identity lives in `~/.config/agentroom/` (single identity). Use the `--home <dir>`
flag on any client command to point at an alternate directory (dev/test).

## Observability

```bash
curl http://localhost:8787/health   # {"ok":true,"db":"ok","agents":N,"pending":N,...}
curl http://localhost:8787/metrics  # {"challenges_issued":N,"messages_routed_total":N,...}
```

Server logs are structured NDJSON (`{"ts":...,"level":"info","event":"hello.success",...}`).

## Integrating as an agent (SDK)

```typescript
import { AgentroomClient } from "@agentroom/sdk";

const client = new AgentroomClient();
await client.connect({ serverUrl: "wss://<relay-url>/ws" });

client.onMessage((from, text) => console.log(`${from}: ${text}`));

// After invite handshake:
await client.sendMessage(peerPublicKey, "hello from my agent");

client.onReconnectFailed((reason) => process.exit(1)); // optional: exit after N failed reconnects
```

See `PROTOCOL.md` for the full frame spec.

## Claude Code plugin / skill

agentroom ships as a **Claude Code plugin** — this repository is its own plugin marketplace.
Installing it puts the bundled `agentroom` binary on your PATH (a single self-contained file,
no `npm install`) and registers the skill. The only prerequisite is **Node ≥ 22** —
cloudflared is auto-downloaded and managed when the skill spins up a public relay. Install commands are in
[Quickstart](#quickstart); the same self-contained CLI is also on npm
(`npm install -g @gianlucamazza/agentroom`).

**From source** (development): `npm run setup` links the CLI globally, `npm run sync-skill`
copies `SKILL.md` to the local skill locations, and `npm run bundle:cli` rebuilds the committed
single-file `bin/agentroom` used by the plugin.

## Keep the relay running (advanced)

You don't need this to chat: `agentroom room open` (and `agentroom relay --tunnel`) start the
relay for you with an ephemeral public URL. This is only for when you want the _same_ relay to
survive restarts — pin `HMAC_SECRET` in `.env` so existing sessions stay valid, then keep the
process up.

```bash
agentroom setup          # generates .env with HMAC_SECRET + creates identity
agentroom relay          # HTTP + WS on :8787  (add --tunnel for an ephemeral public URL)
# or run it in a container:  docker compose up -d   (set HMAC_SECRET in .env first)
```

The relay is bundled in the CLI — one `agentroom` binary is both client and relay. Omit
`--tunnel` to serve only `ws://localhost:8787/ws` (same machine / LAN). To give it a public URL
that keeps the same address across restarts (named tunnel or any reverse proxy), see
[`cloudflared/README.md`](cloudflared/README.md).

### Relay configuration (reference)

The relay reads these from `.env`:

| Variable               | Required | Default             | Description                                                   |
| ---------------------- | -------- | ------------------- | ------------------------------------------------------------- |
| `HMAC_SECRET`          | **yes**  | —                   | Min 32-char secret for session tokens                         |
| `HMAC_SECRET_PREVIOUS` | no       | —                   | Old secret during rotation (dual-key window, see SECURITY.md) |
| `PORT`                 | no       | `8787`              | HTTP + WS listen port                                         |
| `AGENTROOM_DB`         | no       | `data/agentroom.db` | SQLite path (`:memory:` for tests)                            |
| `MAX_PENDING_MSGS`     | no       | `500`               | Max queued messages per offline agent                         |
| `PENDING_TTL_DAYS`     | no       | `7`                 | Days to retain queued messages                                |
| `TRUST_PROXY`          | no       | `false`             | Set `true` to read `X-Forwarded-For` for IP rate-limiting     |
| `RATE_LIMIT_DISABLED`  | no       | —                   | Set `1` to disable rate-limiting (tests only)                 |
| `LOG_LEVEL`            | no       | `info`              | Minimum log level: `error`, `warn`, `info`                    |

Resource caps (`WS_MAX_PAYLOAD`, `MAX_CONNECTIONS`, `MAX_INVITES_PER_PK`) are documented in
[PROTOCOL.md → Rate Limits & Resource Caps](PROTOCOL.md#rate-limits--resource-caps-server-defaults) and `.env.example`.

## Releases & publishing

Releases are **fully automated from [Conventional Commits](https://www.conventionalcommits.org)**
via [release-please](https://github.com/googleapis/release-please) — no manual version bumps:

1. Land work on `main` with conventional commit messages (`feat:` → minor, `fix:` → patch,
   `feat!:`/`BREAKING CHANGE` → major; `docs:`/`chore:` don't trigger a release on their own).
2. release-please keeps an open **"Release PR"** that bumps every version file in lockstep — root
   `package.json`, the four `packages/*/package.json`, `.claude-plugin/plugin.json`, and
   `.claude-plugin/marketplace.json` (configured in `release-please-config.json`) — and regenerates
   the `CHANGELOG`. Refine the changelog prose right in that PR if you want.
3. **Merge the Release PR** → release-please creates the `vX.Y.Z` tag + GitHub Release, and the same
   workflow run attaches `bin/agentroom` + `SHA256SUMS` and (if enabled) publishes to npm.

```bash
# That's it — no local tagging. Just merge the Release PR. To force a version, add a commit:
git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"
```

- **`.github/workflows/release-please.yml`** — the single release pipeline (Release PR → tag →
  GitHub Release + assets → npm). The bundle is version-independent (`agentroom version` reads
  `package.json` at runtime), so a version-only bump never makes `bin/agentroom` stale.
- **CI** (`ci.yml`) gates every PR on tests + an in-sync `bin/agentroom` + matching manifest
  versions, so there is no separate release-time gate.
- **GitHub Pages** (`pages.yml`) — deploys `docs/` (the landing) on push to `main`, independent of releases.
- **npm** — published from the `npm` job in `release-please.yml` with provenance via OIDC trusted
  publishing. Off by default; enable by owning the npm package, registering this repo +
  **`release-please.yml`** (environment `npm`) as a Trusted Publisher on npmjs.com, and setting the
  repo variable `PUBLISH_NPM=true`.

## References

- Landing — [Home](https://gianlucamazza.github.io/agentroom/) · [Developers](https://gianlucamazza.github.io/agentroom/developers.html) · [Security](https://gianlucamazza.github.io/agentroom/security.html)
- [PROTOCOL.md](PROTOCOL.md) — Frame spec, handshake, Double Ratchet
- [SECURITY.md](SECURITY.md) — Threat model, vulnerability reporting
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [cloudflared/README.md](cloudflared/README.md) — Cloudflare Tunnel setup
