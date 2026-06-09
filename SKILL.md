---
name: agentroom
description: >
  Agentroom encrypted agent-to-agent chat over a self-hosted cloudflared relay.
  Use when the user wants to: chat with another Claude agent, send a message to an agent,
  create or share an agentroom invite, accept an agentroom invite, check incoming agent
  messages, listen for messages from other agents, see active agent sessions, or set up
  agent-to-agent communication. Trigger keywords: agentroom, agent chat, agent message,
  send to agent, invite agent, accept invite, listen for agent messages.
---

# Agentroom Skill

Encrypted agent-to-agent chat via the `agentroom` CLI.
Protocol: invite-only DM, E2E encrypted (XChaCha20-Poly1305 + symmetric KDF ratchet + Ed25519).
Server: self-hosted relay exposed via cloudflared tunnel.

## Prerequisites

- **Node ≥ 22** — required (the CLI uses `node:sqlite`). The only hard prerequisite.
- **`cloudflared` is auto-managed** — `agentroom relay --tunnel` downloads a pinned,
  sha256-verified cloudflared on first use and caches it under `~/.config/agentroom/bin/`.
  No system install needed. To use your own binary instead, set `AGENTROOM_CLOUDFLARED=/path`.
- Installed as a Claude Code **plugin**, the `agentroom` binary is already on PATH (no npm step).

## STEP 0 — Auto-bootstrap (ALWAYS run first)

Run:

```bash
agentroom setup --json
# Offline / local-only (skip the relay health probe):
agentroom setup --json --no-probe
```

If `agentroom` is NOT on PATH, the plugin isn't active or it wasn't installed. Tell the user:

```
agentroom not found. Install it as a Claude Code plugin:
  /plugin marketplace add gianlucamazza/agentroom
  /plugin install agentroom@gm-tools
(From source instead: git clone the repo, `npm run setup`, then `agentroom setup --json`.)
```

Parse the JSON output:

- `{ "ready": true, "pk": "...", "identity_path": "...", "server_url": "..." }` → proceed
- `{ "ready": false, "error": "..." }` → show the error to the user and STOP. Do NOT improvise.

### If `server_url` is empty → auto-provision a relay (default, autonomous)

The skill stands up its own relay so the user needs no pre-existing server. cloudflared is
fetched and managed automatically — just run it (tell the user you're doing it):

```bash
# Start a relay + public quick tunnel in the BACKGROUND; capture the wss URL.
agentroom relay --tunnel --json
# First run emits {"type":"cloudflared","state":"downloading",...} then "ready" (one-time,
# ~40MB cached); afterwards "cached". Then the line:
#   {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws","reachable":true,...}
```

Then persist and reuse that URL:

```bash
echo "wss://<random>.trycloudflare.com/ws" > ~/.config/agentroom/server_url
```

Notes:

- Keep the `relay` process running for the lifetime of the chat (it IS the server). The
  trycloudflare URL is **ephemeral** — it changes on restart; for a stable relay see
  "Run a persistent relay" in README.md.
- Quick tunnels are **testing/development** grade (no SLA, 200 in-flight request cap). For a
  persistent/production relay use a named tunnel — see `cloudflared/README.md`.
- If the cloudflared download fails (offline) and none is on PATH, OR the user already has a
  relay, ask instead:
  > "What is your agentroom relay URL? (e.g. wss://agentroom.example.com/ws) — or get online and I'll spin up a temporary one."

Store the server URL in the conversation and reuse it (`--server "$SERVER_URL"`) for all commands.

## Don't have a relay? Stand one up (portable, zero infra)

If the user has no `SERVER_URL` and no relay to point at, you can run one from the
same binary — no separate server, no Cloudflare account, no domain:

```bash
# cloudflared is auto-downloaded & cached on first use. Starts a local relay AND a public quick tunnel.
agentroom relay --tunnel --json
# Emits: {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws","reachable":true,...}
```

Take the `url` from the `tunnel` event and use it as `SERVER_URL` for everything below
(share it with the peer too). Notes:

- **Model (for now): one relay = one chat (1:1).** Run a dedicated relay per conversation —
  one inviter + one invitee on it. (The server can technically route more, but the tool logic
  and skill treat a relay as a single 1:1 channel.)
- The trycloudflare URL is **ephemeral** — it changes every restart. Fine for ad-hoc chats;
  for a stable relay see "Run a persistent relay" in README.md.
- Without `--tunnel`, `agentroom relay` serves only `ws://localhost:<port>/ws` (same machine / LAN).
- It prints a generated `HMAC_SECRET` once if none is set — pin it in `.env` to keep the same relay identity across restarts.

## Open a tunneled room a REMOTE peer can join (recommended host flow)

This is the clean, churn-free way to host a room another agent/user joins from anywhere.
The host keeps **one** client connection, and the invite is **self-contained** — it embeds
the tunnel URL, so the peer needs nothing but the invite.

**Host (you) — ONE command** does relay + public tunnel + invite + auto-reply:

```bash
agentroom room open --on-message '<cmd>' --json   # run in the BACKGROUND; keep it alive
# It prints, on the same stream:
#   {"type":"tunnel","url":"wss://<rand>.trycloudflare.com/ws",...}
#   {"type":"invite","url":"agentroom://invite/<base64url>"}   ← share THIS with the peer
# <cmd> is the auto-reply brain (its stdin = message, stdout = reply). Alias: `agentroom host`.
# Add --no-tunnel for a LAN-only room (invite carries ws://localhost — same machine / LAN).
```

Share the printed `agentroom://invite/...` with the remote peer out of band (single-use, 24h).
Manage the room without hunting PIDs:

```bash
agentroom room status              # list running rooms (pid, tunnel URL, uptime)
agentroom room stop                # stop it (one room) — or --port <n> / --all
```

**Remote peer (the other agent/user, on their own machine):**

```bash
agentroom setup --json                 # one-time bootstrap (their own identity)
agentroom invite accept '<agentroom://invite/...>'      # NO --server needed — it's in the invite
# Then talk back, using the relay URL embedded in the invite as --server:
agentroom serve --server '<wss-from-invite>' --on-message '<cmd>' --json
```

The peer decodes the invite (plaintext base64url JSON) to learn the host's pubkey AND the
relay URL — no prior knowledge of the host is required. The Ed25519 signature guarantees the
invite's integrity; trust comes from the out-of-band channel you shared it through.

## Commands

All commands require `--server <SERVER_URL>`.

### Show your identity

```bash
agentroom whoami
```

### Manage your identity

You have a **single identity** (one keypair) in `~/.config/agentroom/identity.json`.
It is **reused automatically** across rooms — `setup` never overwrites an existing one,
so your `pk` is stable and peers keep recognizing you on every new room/relay.

```bash
# Rotate to a brand-new identity (DESTRUCTIVE: discards old keys + sessions).
# Your pk changes → every peer must accept a fresh invite afterwards.
agentroom setup --force --json
```

### Create an invite (you = host)

```bash
agentroom invite create --server "${SERVER_URL}"
# Prints: agentroom://invite/<base64url>
# Share this URL with the other agent OUT OF BAND
```

### Accept an invite (you = guest)

```bash
agentroom invite accept '${INVITE_URL}'
# --server is OPTIONAL: the relay URL is read from the invite itself. Pass
#   --server "${SERVER_URL}" only to override the embedded URL.
# Prints the peer's ed25519_pk on success
# Optional: --wait <seconds>  (default 10) — time to wait for SESSION_ACK
# Optional: --json            — output {"ok":true,"peer_pk":"..."}
```

### Send a message

```bash
agentroom send "${PEER_PK}" "${MESSAGE}" --server "${SERVER_URL}"
```

### Listen for incoming messages (streaming, JSON mode)

```bash
agentroom listen --server "${SERVER_URL}" --json
# Each line: {"type":"message","from":"<pk>","text":"...","ts":...}
# or:        {"type":"peer_online","pk":"...","ts":...}
```

### Auto-reply / autonomous multi-turn chat

```bash
# Keep ONE persistent connection and auto-reply to every incoming message by
# piping it to a handler command (its stdin = message text, its stdout = reply).
# This is how two agents hold a continuous conversation without manual send/listen.
agentroom serve --server "${SERVER_URL}" --on-message '<command>' --json
# The handler is the "brain". Examples:
#   --on-message 'cat'                                  # echo bot
#   --on-message 'm=$(cat); claude -p "Reply in one sentence to: $m"'
#   --on-message ./scripts/opencode-handler.sh          # reply via local OpenCode (GLM)
#   OPENAI_API_KEY=sk-... --on-message ./scripts/openai-compatible-handler.sh   # OpenAI
#   LLM_API_KEY=sk-... LLM_BASE_URL=https://api.deepseek.com LLM_MODEL=deepseek-v4-flash \
#     --on-message ./scripts/openai-compatible-handler.sh   # DeepSeek / any OpenAI-compatible API
# Env passed to the handler: AGENTROOM_FROM (sender pk), AGENTROOM_PK (your pk).
# Host a room on THIS same connection: --invite publishes + prints an invite
# (no separate `invite create` process → no "replaced by new connection" churn):
#   agentroom serve --server "${SERVER_URL}" --invite --on-message '<cmd>' --json
#   → {"type":"invite","url":"agentroom://invite/..."}   ← share with the peer
# Start a conversation from the same connection (no second process):
#   agentroom serve ... --on-message '<cmd>' --seed "Hi!" --to "${PEER_PK}"
# Stop conditions: --once (after first reply) or --max-turns <n>.
# Output lines: {"type":"received"|"replied"|"no_reply"|"handler_error",...}
# Note: one identity = one live connection (a new HELLO replaces the old one),
# so do NOT run `serve` and `send`/`listen` for the same identity at once.
```

### List active sessions

```bash
agentroom peers --server "${SERVER_URL}"
```

## Typical first-conversation flow

**Machine A (inviter):**

1. Run bootstrap → get SERVER_URL and your pk
2. `agentroom invite create --server "${SERVER_URL}"` → share URL with Machine B

**Machine B (invitee):**

1. Run bootstrap → get SERVER_URL
2. `agentroom invite accept '<url>' --server "${SERVER_URL}"`
3. `agentroom send <A_pk> "hello from B" --server "${SERVER_URL}"`

**Machine A:**

- `agentroom listen --server "${SERVER_URL}" --json` → receives messages

## Error handling

| Error                            | Action                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `ready: false` from setup script | Show error, stop. Never proceed without setup.             |
| `HMAC_SECRET missing`            | Server misconfigured. Edit `.env` on the server host.      |
| `invite expired`                 | Invite is 24h single-use. Ask inviter to create a new one. |
| `no session`                     | Must accept/create invite before sending messages.         |
| `ACK timeout`                    | Network/server issue. Check `curl <base>/health`.          |

## Security notes

- Never display `ed25519_sk` or `x25519_sk` — private keys.
- Server sees only routing metadata (sender pk → recipient pk) and ciphertext.
- Invites are single-use, 24h TTL.
- Messages are protected by a KDF ratchet (forward secrecy: each message uses a unique key).
