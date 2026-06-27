#!/usr/bin/env bash
# Record a REAL Claude Code session that uses the agentroom CLI to message a
# teammate's agent (Bob/Codex) and report the reply. Generates a VHS tape with
# the task prompt typed into the live TUI, then renders it.
#
#   bash demo/live/setup-peer.sh     # once: relay + Bob/Codex + Alice↔Bob session
#   bash demo/live/record.sh         # → docs/media/agentroom-live-raw.webm
#
# Output is the RAW capture; trim/poster into agentroom-live.* afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${AGENTROOM_DEMO_STATE:-/tmp/agentroom-live-demo}"

[ -f "$STATE_DIR/env" ] || {
	echo "record: run demo/live/setup-peer.sh first" >&2
	exit 1
}
set -a
. "$STATE_DIR/env"
set +a
bash "$ROOT/demo/live/prep-config.sh" >/dev/null

TASK="Bob, can your agent add the invite-fallback regression test on the auth branch?"
# Typed prompt: natural ask + the exact agentroom commands to run (no single quotes,
# so it can sit inside a VHS single-quoted Type).
PROMPT="Reach my teammate over agentroom and tell me their reply in one short line. Run: agentroom send $PEER_PK \"$TASK\" --home $ALICE_HOME --server $SERVER_URL  then run: timeout -s KILL 18 agentroom listen --home $ALICE_HOME --server $SERVER_URL --json 2>/dev/null | grep -m1 message || true"

TAPE="$STATE_DIR/live.gen.tape"
cat >"$TAPE" <<TAPEEOF
Output "$ROOT/docs/media/agentroom-live-raw.webm"
Require bash
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 19
Set Width 1280
Set Height 800
Set Padding 28
Set Margin 0
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 14ms
Set Theme { "name": "agentroom", "background": "#0c0c0b", "foreground": "#f4f1ea", "cursor": "#b45f43", "black": "#0c0c0b", "red": "#b45f43", "green": "#7eb078", "yellow": "#c9714f", "blue": "#8f8a82", "magenta": "#c9714f", "cyan": "#a8a29a", "white": "#f4f1ea", "brightBlack": "#78736c", "brightRed": "#c9714f", "brightGreen": "#7eb078", "brightYellow": "#c9714f", "brightBlue": "#a8a29a", "brightMagenta": "#c9714f", "brightCyan": "#f4f1ea", "brightWhite": "#ffffff" }
Hide
Type "bash $ROOT/demo/live/run-claude.sh"
Enter
Sleep 6s
Show
Type '$PROMPT'
Sleep 800ms
Enter
Sleep 55s
TAPEEOF

echo "record: rendering real session (this takes ~2-3 min)…" >&2
vhs "$TAPE"
echo "record: wrote $ROOT/docs/media/agentroom-live-raw.webm" >&2
