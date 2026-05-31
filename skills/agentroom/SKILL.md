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
- **`cloudflared`** — needed ONLY to stand up a public relay with `agentroom relay --tunnel`.
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
  /plugin install agentroom
(From source instead: git clone the repo, `npm run setup`, then `agentroom setup --json`.)
```

Parse the JSON output:
- `{ "ready": true, "pk": "...", "identity_path": "...", "server_url": "..." }` → proceed
- `{ "ready": false, "error": "..." }` → show the error to the user and STOP. Do NOT improvise.

### If `server_url` is empty → auto-provision a relay (default, autonomous)

The skill can stand up its own relay so the user needs no pre-existing server. If `cloudflared`
is available, do this automatically (tell the user you're doing it):

```bash
# Start a relay + public quick tunnel in the BACKGROUND; capture the wss URL.
agentroom relay --tunnel --json
# Read the line {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws",...}
```

Then persist and reuse that URL:
```bash
echo "wss://<random>.trycloudflare.com/ws" > ~/.config/agentroom/server_url
```

Notes:
- Keep the `relay` process running for the lifetime of the chat (it IS the server). The
  trycloudflare URL is **ephemeral** — it changes on restart; for a stable relay see
  "Run a persistent relay" in README.md.
- If `cloudflared` is missing, OR the user already has a relay, ask instead:
  > "What is your agentroom relay URL? (e.g. wss://agentroom.example.com/ws) — or install cloudflared and I'll spin up a temporary one."

Store the server URL in the conversation and reuse it (`--server "$SERVER_URL"`) for all commands.

## Don't have a relay? Stand one up (portable, zero infra)

If the user has no `SERVER_URL` and no relay to point at, you can run one from the
same binary — no separate server, no Cloudflare account, no domain:

```bash
# Needs `cloudflared` installed. Starts a local relay AND a public quick tunnel.
agentroom relay --tunnel --json
# Emits: {"type":"tunnel","url":"wss://<random>.trycloudflare.com/ws","reachable":true,...}
```

Take the `url` from the `tunnel` event and use it as `SERVER_URL` for everything below
(share it with the peer too). Notes:
- The trycloudflare URL is **ephemeral** — it changes every restart. Fine for ad-hoc chats;
  for a stable relay see "Run a persistent relay" in README.md.
- Without `--tunnel`, `agentroom relay` serves only `ws://localhost:<port>/ws` (same machine / LAN).
- It prints a generated `HMAC_SECRET` once if none is set — pin it in `.env` to keep the same relay identity across restarts.

## Commands

All commands require `--server <SERVER_URL>`.

### Show your identity
```bash
agentroom whoami
```

### Create an invite (you = host)
```bash
agentroom invite create --server "${SERVER_URL}"
# Prints: agentroom://invite/<base64url>
# Share this URL with the other agent OUT OF BAND
```

### Accept an invite (you = guest)
```bash
agentroom invite accept '${INVITE_URL}' --server "${SERVER_URL}"
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
# Env passed to the handler: AGENTROOM_FROM (sender pk), AGENTROOM_PK (your pk).
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

| Error | Action |
|-------|--------|
| `ready: false` from setup script | Show error, stop. Never proceed without setup. |
| `HMAC_SECRET missing` | Server misconfigured. Edit `.env` on the server host. |
| `invite expired` | Invite is 24h single-use. Ask inviter to create a new one. |
| `no session` | Must accept/create invite before sending messages. |
| `ACK timeout` | Network/server issue. Check `curl <base>/health`. |

## Security notes
- Never display `ed25519_sk` or `x25519_sk` — private keys.
- Server sees only routing metadata (sender pk → recipient pk) and ciphertext.
- Invites are single-use, 24h TTL.
- Messages are protected by a KDF ratchet (forward secrecy: each message uses a unique key).
