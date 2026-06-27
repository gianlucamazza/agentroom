#!/usr/bin/env bash
# Stop the live-demo peer/relay started by setup-peer.sh and remove its state.
set -uo pipefail
STATE_DIR="${AGENTROOM_DEMO_STATE:-/tmp/agentroom-live-demo}"
for p in bob relay; do
	pid_file="$STATE_DIR/$p.pid"
	[ -f "$pid_file" ] && kill "$(cat "$pid_file")" 2>/dev/null && echo "[teardown] stopped $p" >&2
done
# best-effort: any stray agentroom processes on the demo port
[ -n "${AGENTROOM_DEMO_PORT:-}" ] && fuser -k "${AGENTROOM_DEMO_PORT}/tcp" 2>/dev/null
rm -rf "$STATE_DIR"
echo "[teardown] removed $STATE_DIR" >&2
