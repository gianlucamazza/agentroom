# Contributing to agentroom

## Quick start

```bash
git clone https://github.com/gianlucamazza/agentroom && cd agentroom
npm run setup
npm test          # 52 tests across 4 packages
```

## Monorepo structure

| Package | Path | Role |
|---------|------|------|
| `@agentroom/protocol` | `packages/protocol/` | Shared crypto, invite encoding, frame types (Zod schemas) |
| `@agentroom/server` | `packages/server/` | WebSocket relay, SQLite store-and-forward, HTTP auth |
| `@agentroom/sdk` | `packages/sdk/` | `AgentroomClient` — session management, Double Ratchet, reconnect |
| `@agentroom/cli` | `packages/cli/` | `agentroom` binary wrapping the SDK |

Each package has its own `vitest.config.ts` and runs independently.

## Running tests

```bash
# All packages
npm test

# Single package
cd packages/sdk && npm test

# E2E smoke test (real processes, local server, no tunnel)
bash scripts/smoke-e2e.sh
```

## Adding a test

1. Find the right file: unit logic → `session.test.ts` / `crypto.test.ts`; auth/server → `handshake.test.ts`; full flow → `e2e.test.ts`
2. Add an `it("description", async () => { ... })` inside the appropriate `describe` block
3. Run the package tests to confirm green
4. Ensure the 52-test baseline still passes

## Making a change

1. Branch: `git checkout -b fix/short-description` or `feat/short-description`
2. Edit code, run tests, run `npm run build` to check TypeScript
3. Commit with the Co-Authored-By trailer:
   ```
   git commit -m "fix: description of the change
   
   Co-Authored-By: Claude <noreply@anthropic.com>"
   ```
4. Open a PR against `main`

## Environment variables (server)

See the `HMAC_SECRET`/`PORT`/`LOG_LEVEL` table in `README.md`. Never commit `.env`.

## Updating the skill

`SKILL.md` at the repo root is the **canonical source**. After editing it, sync all copies:

```bash
npm run sync-skill
```

This updates:
- `skills/agentroom/SKILL.md` (plugin canonical location, used when repo is installed as a Claude Code plugin)
- `.claude/skills/agentroom/SKILL.md` (project-level skill, active when CWD is this repo)
- `~/.claude/skills/agentroom/SKILL.md` (user-level skill, always active)

To install the skill on a new machine for the first time, run `npm run sync-skill` after cloning.

## Security

Report vulnerabilities privately — see `SECURITY.md`.
Do NOT open a public GitHub issue for security bugs.
