#!/usr/bin/env bash
# Print the first incoming agentroom message (one JSON line) then exit 0.
# Used by the recorded demo so the listen step ends the instant the peer replies
# — cleanly (no SIGKILL "Killed" job message, no timeout dead-air).
#
#   bash demo/live/listen-once.sh <home> <server> [timeout_seconds]
set -uo pipefail
home="$1"
server="$2"
deadline=$((SECONDS + ${3:-40}))

log="$(mktemp)"
agentroom listen --home "$home" --server "$server" --json >"$log" 2>/dev/null &
pid=$!

line=""
while [ "$SECONDS" -lt "$deadline" ]; do
	line="$(grep -m1 '"type":"message"' "$log" 2>/dev/null)" && [ -n "$line" ] && break
	sleep 0.3
done

kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
[ -n "$line" ] && printf '%s\n' "$line"
rm -f "$log"
exit 0
