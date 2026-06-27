#!/usr/bin/env bash
# Stand up the off-camera side for the live Claude Code demo:
#   - a localhost agentroom relay (no tunnel → no public secrets on screen)
#   - "Bob", a Codex auto-responder: agentroom serve --on-message codex-handler.sh
#   - a pre-established Alice↔Bob session (invite created + accepted off-camera)
#
# Writes a state file the recording wrapper sources (SERVER_URL, PEER_PK = Bob's
# pubkey, ALICE_HOME, HMAC_SECRET). Run demo/live/teardown.sh when done.
#
#   bash demo/live/setup-peer.sh           # start + establish session
#   source <(bash demo/live/setup-peer.sh --print-env)   # also export into shell
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${AGENTROOM_DEMO_STATE:-/tmp/agentroom-live-demo}"
PORT="${AGENTROOM_DEMO_PORT:-8799}"
SERVER_URL="ws://localhost:${PORT}/ws"
export HMAC_SECRET="${HMAC_SECRET:-0000000000000000000000000000000000000000000000000000000000000000}" # localhost only, ≥32 chars, not a real secret

CODEX_H="$ROOT/scripts/codex-handler.sh"
[ -x "$CODEX_H" ] || {
	echo "setup-peer: missing $CODEX_H" >&2
	exit 1
}
command -v agentroom >/dev/null || {
	echo "setup-peer: 'agentroom' not on PATH (run npm run setup)" >&2
	exit 1
}
command -v codex >/dev/null || {
	echo "setup-peer: 'codex' CLI required" >&2
	exit 1
}

mkdir -p "$STATE_DIR"
ALICE_HOME="$STATE_DIR/alice"
BOB_HOME="$STATE_DIR/bob"
mkdir -p "$ALICE_HOME" "$BOB_HOME"

log() { echo "[setup-peer] $*" >&2; }

# --- relay (localhost, no tunnel) ------------------------------------------
agentroom relay --port "$PORT" --db "$STATE_DIR/relay.db" --json \
	>"$STATE_DIR/relay.log" 2>&1 &
echo $! >"$STATE_DIR/relay.pid"
log "relay starting on $SERVER_URL (pid $(cat "$STATE_DIR/relay.pid"))"

# wait for health
for _ in $(seq 1 40); do
	curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1 && break
	sleep 0.25
done
curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1 || {
	echo "setup-peer: relay never became healthy" >&2
	cat "$STATE_DIR/relay.log" >&2
	exit 1
}
log "relay healthy"

# --- identities -------------------------------------------------------------
agentroom setup --home "$ALICE_HOME" --json >/dev/null 2>&1
agentroom setup --home "$BOB_HOME" --json >/dev/null 2>&1

# --- Bob: Codex auto-responder that also publishes an invite ----------------
agentroom serve --home "$BOB_HOME" --server "$SERVER_URL" \
	--on-message "$CODEX_H" --invite --json \
	>"$STATE_DIR/bob.log" 2>&1 &
echo $! >"$STATE_DIR/bob.pid"
log "bob (codex) serving (pid $(cat "$STATE_DIR/bob.pid"))"

# grab Bob's invite URL from his JSON stream
INVITE=""
for _ in $(seq 1 40); do
	INVITE="$(grep -ho 'agentroom://invite/[A-Za-z0-9._-]*' "$STATE_DIR/bob.log" 2>/dev/null | head -1)"
	[ -n "$INVITE" ] && break
	sleep 0.25
done
[ -n "$INVITE" ] || {
	echo "setup-peer: no invite from bob" >&2
	cat "$STATE_DIR/bob.log" >&2
	exit 1
}
log "bob invite captured"

# --- Alice: accept Bob's invite (establishes the session) -------------------
ACCEPT="$(agentroom invite accept "$INVITE" --home "$ALICE_HOME" --server "$SERVER_URL" --json 2>>"$STATE_DIR/alice.log")"
PEER_PK="$(printf '%s' "$ACCEPT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).peer_pk||"")}catch{}})')"
[ -n "$PEER_PK" ] || {
	echo "setup-peer: accept did not return peer_pk: $ACCEPT" >&2
	exit 1
}
log "session established with Bob ($PEER_PK)"

# --- state file -------------------------------------------------------------
cat >"$STATE_DIR/env" <<ENV
SERVER_URL=$SERVER_URL
PEER_PK=$PEER_PK
ALICE_HOME=$ALICE_HOME
BOB_HOME=$BOB_HOME
HMAC_SECRET=$HMAC_SECRET
STATE_DIR=$STATE_DIR
ENV
log "state written to $STATE_DIR/env"

if [ "${1:-}" = "--print-env" ]; then sed 's/^/export /' "$STATE_DIR/env"; fi
log "ready. Tear down with: bash demo/live/teardown.sh"
