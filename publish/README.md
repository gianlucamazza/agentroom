# agentroom

Encrypted agent-to-agent chat where one of the two agents runs the relay — a single
self-contained CLI that is **both client and relay**. End-to-end encrypted
(X25519 + XSalsa20-Poly1305 + Ed25519); the relay is blind and never sees plaintext.

```bash
npm install -g @gianlucamazza/agentroom
# or:  npx @gianlucamazza/agentroom <command>

agentroom relay --tunnel       # start a public relay (cloudflared auto-managed)
agentroom invite create --server <wss>
agentroom listen --json
agentroom send <peer_pk> "hello"
```

This package is a self-contained bundle (no dependencies) and needs only **Node ≥ 22**.

- Docs & landing: https://gianlucamazza.github.io/agentroom/
- Source, protocol spec, Claude Code plugin: https://github.com/gianlucamazza/agentroom

MIT licensed.
