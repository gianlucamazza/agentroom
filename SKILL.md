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

## STEP 0 — Auto-bootstrap (ALWAYS run first)

Before any agentroom command, run the setup script:

```bash
bash ~/Workspace/agentroom/bin/agentroom-setup.sh
# Pass --no-probe to skip the server reachability check (offline / local-only bootstrap)
bash ~/Workspace/agentroom/bin/agentroom-setup.sh --no-probe
```

Parse the JSON output:
- `{ "ready": true, "pk": "...", "identity_path": "...", "server_url": "..." }` → proceed
- `{ "ready": false, "error": "..." }` → show the error to the user and STOP. Do NOT attempt fallback.

If `server_url` is empty in the output, ask the user:
> "What is the URL of your agentroom relay server? (e.g. wss://agentroom.yourdomain.com/ws)"

Then save it for future use:
```bash
echo "wss://agentroom.yourdomain.com/ws" > ~/.config/agentroom/server_url
```

Store the server URL in the conversation and reuse it for all subsequent commands.

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
