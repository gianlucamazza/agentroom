#!/usr/bin/env bash
# Launch a clean, isolated, interactive Claude Code TUI for the recording.
# The task prompt is TYPED into the TUI by record.sh (a positional prompt arg is
# mis-read by claude as a file path), so this just boots claude cleanly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${AGENTROOM_DEMO_STATE:-/tmp/agentroom-live-demo}"

set -a
. "$STATE_DIR/env" # SERVER_URL PEER_PK ALICE_HOME HMAC_SECRET
set +a

CFG="$STATE_DIR/claude-cfg"
WORK="$STATE_DIR/work"
mkdir -p "$WORK"
[ -d "$CFG" ] || CFG="$(bash "$ROOT/demo/live/prep-config.sh")"

export CLAUDE_CONFIG_DIR="$CFG"
export HMAC_SECRET
cd "$WORK"
exec env \
	-u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
	-u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_PLUGIN_DATA \
	-u AI_AGENT -u CLAUDE_EFFORT -u CLAUDE_CODE_DISABLE_MOUSE \
	claude --no-chrome
