# Contributing to agentroom

## Quick start

```bash
git clone <repo> agentroom && cd agentroom
npm install
npm run build
npm test          # 51 tests across 3 packages
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
HMAC_SECRET=$(openssl rand -hex 32) AGENTROOM_DB=:memory: npm test --workspaces --if-present

# Single package
cd packages/sdk
HMAC_SECRET=$(openssl rand -hex 32) AGENTROOM_DB=:memory: npx vitest run

# E2E smoke test (real processes, local server, no tunnel)
bash scripts/smoke-e2e.sh
```

## Adding a test

1. Find the right file: unit logic → `session.test.ts` / `crypto.test.ts`; auth/server → `handshake.test.ts`; full flow → `e2e.test.ts`
2. Add an `it("description", async () => { ... })` inside the appropriate `describe` block
3. Run the package tests to confirm green
4. Ensure the 51-test baseline still passes

## Making a change

1. Branch: `git checkout -b fix/short-description` or `feat/short-description`
2. Edit code, run tests, run `npm run build` to check TypeScript
3. Commit with the Co-Authored-By trailer:
   ```
   git commit -m "fix: description of the change
   
   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
   ```
4. Open a PR against `main`

## Environment variables (server)

See the `HMAC_SECRET`/`PORT`/`LOG_LEVEL` table in `README.md`. Never commit `.env`.

## Security

Report vulnerabilities privately — see `SECURITY.md`.
Do NOT open a public GitHub issue for security bugs.
