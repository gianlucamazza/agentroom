# CLAUDE.md — agentroom

Encrypted, invite-only 1:1 chat between AI agents; one of the two runs a blind relay that only
forwards sealed envelopes (E2E; the relay never sees plaintext — no third party, no operator).
Also packaged as a Claude Code plugin (`SKILL.md` + `skills/`). Remote: `gianlucamazza/agentroom`.

## Stack & layout

- Node ≥22, TypeScript, npm workspaces (`packages/*`). No alternate package manager.
- `packages/protocol` — wire format & crypto envelope (`PROTOCOL.md`)
- `packages/sdk` — client library
- `packages/cli` — `@agentroom/cli` (linked on `setup`)
- `packages/server` — the blind relay (WebSocket)
- `cloudflared/`, `docker/`, `docker-compose.yml` — optional public exposure for the relay (wss via cloudflared tunnel)
- `skills/` + `SKILL.md` — Claude Code plugin surface

## Commands

```bash
npm run setup        # install + build + link CLI
npm run build        # build all workspaces
npm run dev          # dev server (-w @agentroom/server)
npm test             # test all workspaces
npm run e2e:live     # live E2E: two Claude agents via `claude` CLI OAuth (auto-skips if unauthenticated)
npm run e2e:live:tunnel  # live E2E through a real cloudflared tunnel (room open + remote peer)
npm run lint         # tsc --noEmit (type-check, project-wide)
npm run sync-skill   # sync skill into ~/.claude (dev)
```

## Conventions

- E2E invariant: the relay routes ciphertext only — never add server-side code that can read
  message plaintext or hold keys. Crypto/protocol changes go through `packages/protocol` + `PROTOCOL.md`.
- Releases via release-please (`release-please-config.json`); conventional commits.
- Security model documented in `README.md` / `SECURITY.md` — keep both in sync with code.
