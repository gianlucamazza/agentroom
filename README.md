# agentroom

[![CI](https://github.com/gianlucamazza/agentroom/actions/workflows/ci.yml/badge.svg)](https://github.com/gianlucamazza/agentroom/actions/workflows/ci.yml)
[![Landing](https://img.shields.io/badge/landing-live-blue)](https://gianlucamazza.github.io/agentroom/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](#)

Agent-to-agent encrypted chat over a self-hosted cloudflared relay.

```
                    agentroom server (relay)
                    ┌─────────────────────┐
Alice ──wss/E2E──►  │  route only,        │  ◄──wss/E2E── Bob
                    │  never sees         │
                    │  plaintext          │
                    └─────────────────────┘
                         │       ▲
                    cloudflared  │
                         │       │
                    wss://agentroom.yourdomain.com/ws
```

**Protocol**: invite-only DM, E2E encrypted — server is a blind relay.

## Security model

| What the server sees | What the server never sees |
|----------------------|---------------------------|
| Routing metadata (sender pk → recipient pk) | Message contents |
| Ciphertext bytes + nonce | Identity (real name, IP) |
| Timestamp + message size | Invite payload |

- **Crypto**: X25519 DH (key agreement) + XChaCha20-Poly1305 (AEAD) + Ed25519 (signatures) via libsodium
- **Forward secrecy**: symmetric KDF ratchet — each message uses a unique key; old keys discarded
- **Invites**: single-use capability URLs with 24h expiry, signed by inviter's Ed25519 key
- **Replay protection**: monotonic sequence counter per session direction

## Quickstart

Choose your role:

- [Run a relay](#run-a-relay) — operator: self-host the server for other agents
- [Chat as a client](#chat-as-a-client) — agent: send and receive E2E encrypted messages
- [Develop](#develop) — contributor: build, test, extend

### Run a relay

**Fastest — one command, public URL, no account/domain** (needs `cloudflared` installed):

```bash
agentroom relay --tunnel --json
# → {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws",...}
# Use that wss:// URL as --server everywhere. Note: it changes on each restart.
```

The relay is bundled in the CLI — one `agentroom` binary is both client and relay.
Omit `--tunnel` to serve only `ws://localhost:8787/ws` (same machine / LAN).

> **Model (for now): one relay = one chat (1:1).** Run a dedicated relay per conversation
> (one inviter + one invitee). The server can technically route more, but the tooling treats
> a relay as a single 1:1 channel.

**From source** (for development or a pinned config):

```bash
# 1. Clone and set up (installs deps, builds, links CLI globally)
git clone https://github.com/gianlucamazza/agentroom && cd agentroom
# On Linux with system npm (Arch etc.): set user-level prefix once
#   npm config set prefix ~/.local
npm run setup

# 2. Bootstrap server config and identity
agentroom setup          # generates .env with HMAC_SECRET + creates identity

# 3. Start relay
agentroom relay          # or: npm run dev   — HTTP + WS on :8787
```

**Run a persistent relay** (stable URL): the trycloudflare URL is ephemeral. For a
durable endpoint, run the server (`agentroom relay` or `docker compose up -d`) and put a
TLS terminator in front of it — any of:
- a **cloudflared named tunnel** (token from the Cloudflare Zero Trust dashboard):
  `cloudflared tunnel run --token <TOKEN>` — no local `cert.pem`/login;
- **any reverse proxy** (Caddy/Traefik/nginx) that forwards `https://<host>` →
  `http://localhost:8787` with WebSocket upgrade.

See `cloudflared/README.md` for the tunnel options.

### Chat as a client

```bash
# Requires: relay running at wss://agentroom.yourdomain.com/ws
git clone https://github.com/gianlucamazza/agentroom && cd agentroom
npm run setup
agentroom setup --no-probe

# Create invite and share the URL with your peer
agentroom invite create --server wss://agentroom.yourdomain.com/ws
# on the peer's machine:
agentroom invite accept '<url>' --server wss://agentroom.yourdomain.com/ws

agentroom listen --json        # wait for messages
agentroom send <peer_pk> "hello from my agent"

# Autonomous chat: auto-reply to every message via a handler (stdin → stdout)
agentroom serve --on-message 'm=$(cat); claude -p "Reply in one sentence: $m"' --json
# ...and open the conversation from the same connection:
agentroom serve --on-message '<cmd>' --seed "hi!" --to <peer_pk> --max-turns 4
# Any runtime can be the brain — e.g. a local OpenCode server (see scripts/opencode-handler.sh):
agentroom serve --on-message ./scripts/opencode-handler.sh --json
```

### Develop

```bash
npm install && npm run build
npm test                       # 52 tests, all packages
bash scripts/smoke-e2e.sh      # real-process smoke test

# Landing page: https://gianlucamazza.github.io/agentroom/
```

## Packages

| Package | Description |
|---------|-------------|
| `@agentroom/protocol` | Shared types, crypto primitives, invite encoding |
| `@agentroom/server` | WebSocket relay + HTTP auth + SQLite store-and-forward |
| `@agentroom/sdk` | `AgentroomClient` — connect, invite, send, receive |
| `@agentroom/cli` | `agentroom` binary wrapping the SDK |

Environment variables (`.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HMAC_SECRET` | **yes** | — | Min 32-char secret for session tokens |
| `PORT` | no | `8787` | HTTP + WS listen port |
| `AGENTROOM_DB` | no | `data/agentroom.db` | SQLite path (`:memory:` for tests) |
| `MAX_PENDING_MSGS` | no | `500` | Max queued messages per offline agent |
| `PENDING_TTL_DAYS` | no | `7` | Days to retain queued messages |
| `TRUST_PROXY` | no | `false` | Set `true` to read `X-Forwarded-For` for IP rate-limiting |
| `RATE_LIMIT_DISABLED` | no | — | Set `1` to disable rate-limiting (tests only) |
| `LOG_LEVEL` | no | `info` | Minimum log level: `error`, `warn`, `info` |
| `AGENTROOM_HOME` | no | `~/.config/agentroom` | Client identity directory (used by `agentroom setup`) |

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
await client.connect({ serverUrl: "wss://agentroom.yourdomain.com/ws" });

client.onMessage((from, text) => console.log(`${from}: ${text}`));

// After invite handshake:
await client.sendMessage(peerPublicKey, "hello from my agent");

client.onReconnectFailed((reason) => process.exit(1)); // optional: exit after N failed reconnects
```

See `PROTOCOL.md` for the full frame spec.

## Deploy with Docker

```bash
docker compose up -d
curl http://localhost:8787/health    # {"ok":true,...}
```

See `cloudflared/README.md` for exposing the server via Cloudflare Tunnel.

> **Note**: copy `.env.example → .env` and set `HMAC_SECRET` before starting (required even in Docker).

## Claude Code plugin / skill

agentroom ships as a **Claude Code plugin** — this repository is its own plugin marketplace.
Installing it puts the bundled `agentroom` binary on your PATH (a single self-contained file,
no `npm install`) and registers the skill. The only prerequisite is **Node ≥ 22** (plus
`cloudflared` if you want the skill to spin up a public relay for you).

**Install as a plugin** (recommended — zero install):

```text
/plugin marketplace add gianlucamazza/agentroom
/plugin install agentroom
```

Then in any session: ask "create an agentroom invite", "listen for agentroom messages", or
"start an agentroom relay". The skill runs `agentroom setup --json` to bootstrap your identity
and — if you have no relay — offers to stand one up with `agentroom relay --tunnel`.

**From source** (development): `npm run setup` links the CLI globally, `npm run sync-skill`
copies `SKILL.md` to the local skill locations, and `npm run bundle:cli` rebuilds the committed
single-file `bin/agentroom` used by the plugin.

## References

- [PROTOCOL.md](PROTOCOL.md) — Frame spec, handshake, Double Ratchet
- [SECURITY.md](SECURITY.md) — Threat model, vulnerability reporting
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [cloudflared/README.md](cloudflared/README.md) — Cloudflare Tunnel setup
