## What

<!-- One or two sentences: what does this PR change and why. -->

## Checklist

- [ ] Conventional commit title (`feat:`/`fix:`/`docs:`/`test:`/`chore:` — drives release-please)
- [ ] `npm test` and `npm run lint` pass locally
- [ ] E2E invariant respected: no server-side code can read message plaintext or hold keys
- [ ] Crypto/protocol changes go through `packages/protocol` + `PROTOCOL.md`
- [ ] `README.md` / `SECURITY.md` kept in sync if the security model changed
