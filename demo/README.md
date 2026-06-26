# demo/ — landing-page demo video

Branded terminal demo for the [agentroom landing](../docs/). Shows the product
story: **colleagues on one project, each in a different coding tool** (Claude
Code, Codex, OpenCode), whose agents coordinate directly over agentroom —
encrypted, peer-to-peer, no shared login. Each agent's reply is real output from
its own CLI (`claude`, `codex exec`, `opencode run`); agentroom is the private
line between them, plugged in via `agentroom serve --on-message <cli>`.

Rendered with [VHS](https://github.com/charmbracelet/vhs) to deterministic
WebM/MP4 that GitHub Pages serves from `docs/media/`.

## Files

| File              | Role                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript.json` | Source of truth: peer roster (name · tool · CLI), encrypted badge, the one wiring line, and the conversation. Real CLI output is written here by `capture.sh`. |
| `capture.sh`      | Runs the real `claude` + `codex` handlers to fill `transcript.json` with genuine replies.                                                                      |
| `playback.sh`     | Deterministic terminal player — draws `transcript.json` with absolute cursor positioning. No network.                                                          |
| `_load.mjs`       | Parses `transcript.json` into bash variables for `playback.sh`.                                                                                                |
| `hero.tape`       | VHS script → `docs/media/agentroom-demo.{webm,mp4}` (1440×600, ~18s hero loop).                                                                                |
| `developers.tape` | VHS script → `docs/media/agentroom-demo-dev.{webm,mp4}` (1200×760, taller walkthrough).                                                                        |

## Regenerate

```bash
# 1. (optional) refresh the content with real model output — needs claude + codex CLIs
bash demo/capture.sh

# 2. render the assets (deterministic: same transcript → same take)
vhs demo/hero.tape
vhs demo/developers.tape

# 3. refresh the poster frame used before the video plays
ffmpeg -y -ss 9.5 -i docs/media/agentroom-demo.mp4 -frames:v 1 docs/media/agentroom-demo-poster.png
```

Preview locally: `python -m http.server -d docs` → http://localhost:8000.

## Notes

- **Determinism / "real" content.** All animation timing lives in `playback.sh`,
  so renders are reproducible. The _words_ come from `capture.sh` running the
  actual handlers — real model output, captured once, replayed cleanly (live LLM
  latency never enters the render).
- **No secrets.** The capture path never handles public keys, invite URLs, or
  tunnel hosts; the one command shown with an invite uses `demo-redacted`. Keep
  it that way if you edit `transcript.json` by hand.
- **Fonts.** The tapes use `JetBrainsMono Nerd Font Mono` (brand mono) and the
  brand palette (terracotta `#b45f43` on near-black `#0c0c0b`). Install the
  Nerd Font variant, or change `Set FontFamily` in the tapes.
- **Reduced motion.** `docs/app.js` disables autoplay and shows the poster when
  the visitor prefers reduced motion.
