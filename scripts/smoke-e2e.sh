#!/usr/bin/env bash
# smoke-e2e.sh — end-to-end smoke test using real CLI processes
# Scenarios:
#   1. Basic invite → listen → send → receive
#   2. Session persistence restart (send works after creating new process)
#   3. Store-and-forward: message queued while recipient offline, delivered on reconnect
#   4. Server restart + client reconnect
# Usage: bash scripts/smoke-e2e.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/agentroom-smoke.XXXXXX)"
SERVER_PID=""
LISTEN_PID=""
LISTEN2_PID=""

cleanup() {
	[[ -n "$LISTEN_PID" ]] && kill "$LISTEN_PID" 2>/dev/null || true
	[[ -n "$LISTEN2_PID" ]] && kill "$LISTEN2_PID" 2>/dev/null || true
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() { echo "[smoke] $*" >&2; }
pass() { echo "[smoke] ✓ $*" >&2; }
fail() {
	echo "[smoke] FAIL: $*" >&2
	exit 1
}

wait_for() {
	local file="$1" pattern="$2" max_s="${3:-5}"
	for _ in $(seq 1 "$((max_s * 5))"); do
		sleep 0.2
		grep -q "$pattern" "$file" 2>/dev/null && return 0
	done
	return 1
}

# Wait until at least N agents are connected (uses /metrics ws_connections — live WS count,
# not /health agents which is the DB count and doesn't reset on server restart)
wait_agents() {
	local n="${1:-1}" max_s="${2:-5}"
	for _ in $(seq 1 "$((max_s * 5))"); do
		sleep 0.2
		local count
		count=$(curl -sf "http://localhost:$TEST_PORT/metrics" 2>/dev/null | grep -o '"ws_connections":[0-9]*' | grep -o '[0-9]*$' || echo 0)
		[[ "${count:-0}" -ge "$n" ]] && return 0
	done
	return 1
}

# ── Prerequisites ─────────────────────────────────────────────────────────────
log "checking prerequisites..."
command -v node >/dev/null 2>&1 || fail "node not found"
node_major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
[[ "$node_major" -ge 22 ]] || fail "Node >= 22 required (found $node_major)"

# Build if dist is stale
if [[ ! -f "$REPO_ROOT/packages/cli/dist/index.js" ]]; then
	log "building..."
	cd "$REPO_ROOT" && npm run build >/dev/null 2>&1
fi

AGENTROOM_BIN="$REPO_ROOT/packages/cli/dist/index.js"
[[ -f "$AGENTROOM_BIN" ]] || fail "CLI not found at $AGENTROOM_BIN"
AR="node $AGENTROOM_BIN"

# ── Generate test .env ────────────────────────────────────────────────────────
log "generating test .env..."
TEST_SECRET="$(openssl rand -hex 32)"
TEST_PORT=8900
for p in $(seq 8900 8950); do
	if ! ss -tlnp 2>/dev/null | grep -q ":$p "; then
		TEST_PORT=$p
		break
	fi
done

SERVER_LOG="$WORK_DIR/server.log"
SERVER_DB="$WORK_DIR/agentroom.db"
SERVER_CMD="node $REPO_ROOT/packages/server/dist/index.js"

start_server() {
	HMAC_SECRET="$TEST_SECRET" PORT="$TEST_PORT" AGENTROOM_DB="$SERVER_DB" \
		$SERVER_CMD >>"$SERVER_LOG" 2>&1 &
	SERVER_PID=$!
	for _ in $(seq 1 20); do
		sleep 0.2
		curl -sf "http://localhost:$TEST_PORT/health" >/dev/null 2>&1 && return 0
		kill -0 "$SERVER_PID" 2>/dev/null || fail "server died. Log: $(tail -5 "$SERVER_LOG")"
	done
	fail "server did not start. Log: $(tail -5 "$SERVER_LOG")"
}

# ── Start server ──────────────────────────────────────────────────────────────
log "starting server on :$TEST_PORT ..."
start_server
log "server ready"

SERVER_WS="ws://localhost:$TEST_PORT/ws"
ALICE_HOME="$WORK_DIR/alice"
BOB_HOME="$WORK_DIR/bob"

# ── Init identities ───────────────────────────────────────────────────────────
log "initializing alice and bob identities..."
$AR init --home "$ALICE_HOME" >/dev/null
$AR init --home "$BOB_HOME" >/dev/null

ALICE_PK=$($AR whoami --home "$ALICE_HOME" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.ed25519_pk)")
# (only Alice's pk is needed: Bob is always the sender in the scenarios below)

# ── Invite flow ───────────────────────────────────────────────────────────────
log "alice creates invite..."
INVITE_URL=$($AR invite create --home "$ALICE_HOME" --server "$SERVER_WS" | grep "^agentroom://")
[[ -n "$INVITE_URL" ]] || fail "no invite URL captured"

log "bob accepts invite..."
# Alice isn't listening yet → handshake may timeout (expected); session is saved and
# SESSION_INIT is queued for Alice. Use || true so set -e doesn't abort on exit code 3.
$AR invite accept "$INVITE_URL" --home "$BOB_HOME" --server "$SERVER_WS" >/dev/null || true
sleep 0.5 # wait for SESSION_INIT to be queued for Alice

# ════════════════════════════════════════════════════════════════════
# SCENARIO 1: Basic send → receive
# ════════════════════════════════════════════════════════════════════
log "=== Scenario 1: basic send → receive ==="

ALICE_LOG="$WORK_DIR/alice_listen.jsonl"
$AR listen --home "$ALICE_HOME" --server "$SERVER_WS" --json >"$ALICE_LOG" 2>&1 &
LISTEN_PID=$!
sleep 0.3

$AR send "$ALICE_PK" "hello from bob smoke test" --home "$BOB_HOME" --server "$SERVER_WS"

wait_for "$ALICE_LOG" "hello from bob smoke test" 5 || fail "scenario 1: message not received"
pass "scenario 1: message delivered"

kill "$LISTEN_PID" 2>/dev/null
LISTEN_PID=""
sleep 0.2

# ════════════════════════════════════════════════════════════════════
# SCENARIO 2: Session persistence — send works after process restart
# ════════════════════════════════════════════════════════════════════
log "=== Scenario 2: session persistence ==="

ALICE_LOG2="$WORK_DIR/alice_listen2.jsonl"
$AR listen --home "$ALICE_HOME" --server "$SERVER_WS" --json >"$ALICE_LOG2" 2>&1 &
LISTEN_PID=$!
sleep 0.3

# Bob sends AGAIN — same session loaded from disk (no handshake needed)
$AR send "$ALICE_PK" "session persisted across restart" --home "$BOB_HOME" --server "$SERVER_WS"

wait_for "$ALICE_LOG2" "session persisted across restart" 5 || fail "scenario 2: persisted session not working"
pass "scenario 2: session persistence OK"

kill "$LISTEN_PID" 2>/dev/null
LISTEN_PID=""
sleep 0.2

# Verify bob sees alice in peers list (sessions dir)
PEERS_JSON=$($AR peers --home "$BOB_HOME" --json)
echo "$PEERS_JSON" | grep -q "$ALICE_PK" || fail "scenario 2: alice not in bob's peers list"
pass "scenario 2: peers list correct"

# ════════════════════════════════════════════════════════════════════
# SCENARIO 3: Store-and-forward (offline → online)
# ════════════════════════════════════════════════════════════════════
log "=== Scenario 3: store-and-forward ==="

# Alice is offline — bob sends while alice is down
$AR send "$ALICE_PK" "queued while alice offline" --home "$BOB_HOME" --server "$SERVER_WS"
log "message queued to offline alice"

ALICE_LOG3="$WORK_DIR/alice_listen3.jsonl"
$AR listen --home "$ALICE_HOME" --server "$SERVER_WS" --json >"$ALICE_LOG3" 2>&1 &
LISTEN_PID=$!

wait_for "$ALICE_LOG3" "queued while alice offline" 8 || fail "scenario 3: queued message not delivered on reconnect"
pass "scenario 3: store-and-forward OK"

kill "$LISTEN_PID" 2>/dev/null
LISTEN_PID=""
sleep 0.2

# ════════════════════════════════════════════════════════════════════
# SCENARIO 4: Server restart → client reconnects and resumes
# ════════════════════════════════════════════════════════════════════
log "=== Scenario 4: server restart + client reconnect ==="

ALICE_LOG4="$WORK_DIR/alice_listen4.jsonl"
$AR listen --home "$ALICE_HOME" --server "$SERVER_WS" --json >"$ALICE_LOG4" 2>&1 &
LISTEN_PID=$!
# Wait until Alice is registered with server before killing it
wait_agents 1 8 || log "warning: alice may not have connected yet (proceeding)"

# Kill server
log "killing server..."
kill "$SERVER_PID" 2>/dev/null
SERVER_PID=""
sleep 0.3

# Restart server
log "restarting server..."
start_server

# Wait until Alice reconnects (SDK auto-reconnect: 1s, 2s, 4s backoff)
wait_agents 1 20 || log "warning: alice may not have reconnected (proceeding)"

$AR send "$ALICE_PK" "after server restart" --home "$BOB_HOME" --server "$SERVER_WS"

wait_for "$ALICE_LOG4" "after server restart" 15 || {
	log "alice log: $(cat "$ALICE_LOG4" 2>/dev/null || echo '(empty)')"
	fail "scenario 4: message not received after server restart"
}
pass "scenario 4: server restart + reconnect OK"

kill "$LISTEN_PID" 2>/dev/null
LISTEN_PID=""

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
log "All smoke scenarios passed ✓"
