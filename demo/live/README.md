# demo/live — record a REAL Claude Code session

Produces `docs/media/agentroom-live.{webm,mp4}` + poster: a genuine recording of
the Claude Code TUI using the `agentroom` CLI to message a teammate's agent
(Bob = a Codex auto-responder) over a localhost relay, and reporting the reply.
Not a mockup — the words are real `claude` + `codex` output.

## Regenerate

```bash
bash demo/live/setup-peer.sh      # localhost relay + Bob/Codex serve + Alice↔Bob session
bash demo/live/record.sh          # drives a clean `claude` TUI under VHS → docs/media/agentroom-live-raw.webm
# then finalize (trim boot tail, make mp4 + poster):
ffmpeg -y -ss 0.6 -i docs/media/agentroom-live-raw.webm -c:v libvpx-vp9 -b:v 0 -crf 34 -an docs/media/agentroom-live.webm
ffmpeg -y -ss 0.6 -i docs/media/agentroom-live-raw.webm -c:v libx264 -pix_fmt yuv420p -crf 24 -an docs/media/agentroom-live.mp4
ffmpeg -y -sseof -0.8 -i docs/media/agentroom-live-raw.webm -frames:v 1 docs/media/agentroom-live-poster.png
bash demo/live/teardown.sh        # stop relay/peer, remove /tmp state
```

## How it stays clean & safe

- **`setup-peer.sh`** runs the relay on `ws://localhost:<port>` (no cloudflared
  tunnel → no public hostnames on screen), pins a localhost `HMAC_SECRET`, and
  establishes the Alice↔Bob session off-camera so no invite URL is recorded. The
  only identifiers shown are a **public** key and the localhost URL — no secrets.
- **`prep-config.sh`** builds an isolated `CLAUDE_CONFIG_DIR` for the recorded
  session: copies your OAuth credentials, seeds onboarding/"seen" flags from your
  real config (minus all personal data — no projects, MCP, history), sets a dark
  theme and **no** hooks / output-style, and an allow-list (`Bash(agentroom:*)`,
  `Bash(timeout:*)`) so commands run with no permission prompts or scary banners.
- **`record.sh`** types the task into the live TUI (a positional prompt arg is
  mis-read by `claude` as a file), then VHS captures the real session. The listen
  step is `timeout -s KILL 18 … | grep -m1 message || true` so it ends cleanly
  with a green (exit 0) tool call, not a red timeout error.

## Notes

- Non-deterministic: Codex phrases its reply differently each run — that's the
  point. Re-run `record.sh` until you get a take you like.
- Requires `claude`, `codex`, `agentroom` (run `npm run setup`), `vhs`, `ffmpeg`.
- The earlier **stylized** reconstruction lives in `demo/playback.sh` + tapes; it
  is superseded by this real recording but kept for reference.
