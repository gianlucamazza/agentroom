#!/usr/bin/env bash
# e2e-live.sh — live end-to-end test: two REAL Claude agents talking over the relay.
#
# Alice and Bob are two `agentroom serve` processes whose --on-message handler is
# scripts/claude-handler.sh (the local `claude` CLI via Claude Code OAuth — no
# ANTHROPIC_API_KEY, no secrets). Bob seeds the conversation; both sides are
# bounded with --max-turns 2, so the whole run costs 3 LLM calls (+1 auth probe),
# all on the cheapest model.
#
# Local-only: auto-SKIPs (exit 0) when `claude` is missing/unauthenticated or
# when AGENTROOM_E2E_LIVE=0. After the auth probe passes, every error is a FAIL.
#
# Usage: bash scripts/e2e-live.sh   (or: npm run e2e:live)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/agentroom-live.XXXXXX)"
SERVER_PID=""
ALICE_SERVE_PID=""
BOB_SERVE_PID=""

cleanup() {
	[[ -n "$ALICE_SERVE_PID" ]] && kill "$ALICE_SERVE_PID" 2>/dev/null || true
	[[ -n "$BOB_SERVE_PID" ]] && kill "$BOB_SERVE_PID" 2>/dev/null || true
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() { echo "[live] $*" >&2; }
pass() { echo "[live] ✓ $*" >&2; }
skip() {
	echo "[live] SKIP: $*" >&2
	exit 0
}
fail() {
	echo "[live] FAIL: $*" >&2
	echo "[live] --- alice log ---" >&2
	cat "${ALICE_LOG:-/dev/null}" 2>/dev/null >&2 || true
	echo "[live] --- bob log ---" >&2
	cat "${BOB_LOG:-/dev/null}" 2>/dev/null >&2 || true
	exit 1
}

wait_for() {
	local file="$1" pattern="$2" max_s="${3:-5}"
	for i in $(seq 1 "$((max_s * 5))"); do
		sleep 0.2
		grep -q "$pattern" "$file" 2>/dev/null && return 0
	done
	return 1
}

# ── Skip checks (before anything else) ────────────────────────────────────────
[[ "${AGENTROOM_E2E_LIVE:-1}" == "0" ]] && skip "disabled via AGENTROOM_E2E_LIVE=0"
command -v claude >/dev/null 2>&1 || skip "claude CLI not found"

log "probing claude auth (one tiny haiku call)..."
probe="$(timeout 60 claude -p "Reply with the single word: ok" --model haiku </dev/null 2>/dev/null)" || skip "claude probe failed — not authenticated?"
[[ -n "$probe" ]] || skip "claude probe returned empty output"
pass "claude CLI available and authenticated"

# ── Prerequisites ─────────────────────────────────────────────────────────────
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
HANDLER="$REPO_ROOT/scripts/claude-handler.sh"
[[ -x "$HANDLER" ]] || fail "handler not executable at $HANDLER"

# ── Start relay ───────────────────────────────────────────────────────────────
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
	for i in $(seq 1 20); do
		sleep 0.2
		curl -sf "http://localhost:$TEST_PORT/health" >/dev/null 2>&1 && return 0
		kill -0 "$SERVER_PID" 2>/dev/null || fail "server died. Log: $(tail -5 "$SERVER_LOG")"
	done
	fail "server did not start. Log: $(tail -5 "$SERVER_LOG")"
}

log "starting relay on :$TEST_PORT ..."
start_server
log "relay ready"

SERVER_WS="ws://localhost:$TEST_PORT/ws"
ALICE_HOME="$WORK_DIR/alice"
BOB_HOME="$WORK_DIR/bob"

# ── Init identities + invite dance ────────────────────────────────────────────
log "initializing alice and bob identities..."
$AR init --home "$ALICE_HOME" >/dev/null
$AR init --home "$BOB_HOME" >/dev/null

ALICE_PK=$($AR whoami --home "$ALICE_HOME" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.ed25519_pk)")

log "alice creates invite..."
INVITE_URL=$($AR invite create --home "$ALICE_HOME" --server "$SERVER_WS" | grep "^agentroom://")
[[ -n "$INVITE_URL" ]] || fail "no invite URL captured"

log "bob accepts invite..."
# Alice isn't online yet → handshake may timeout (expected); session is saved and
# SESSION_INIT is queued for Alice. Use || true so set -e doesn't abort on exit code 3.
$AR invite accept "$INVITE_URL" --home "$BOB_HOME" --server "$SERVER_WS" >/dev/null || true
sleep 0.5 # wait for SESSION_INIT to be queued for Alice

# ── Live conversation: Claude ↔ Claude ────────────────────────────────────────
# Bob seeds (turn 1 for him), Alice replies (A1), Bob replies (B2 → done, exits),
# Alice replies (A2 → done; send lands in store-and-forward since Bob is gone).
# 3 LLM calls total, all bounded by --max-turns 2 on each side.
log "=== live conversation: 2 turns per side, 3 LLM calls ==="

ALICE_LOG="$WORK_DIR/alice_serve.jsonl"
BOB_LOG="$WORK_DIR/bob_serve.jsonl"

log "starting alice (responder)..."
$AR serve --home "$ALICE_HOME" --server "$SERVER_WS" \
	--on-message "$HANDLER" --max-turns 2 --handler-timeout 100 --json \
	>"$ALICE_LOG" 2>&1 &
ALICE_SERVE_PID=$!
wait_for "$ALICE_LOG" '"type":"serving"' 10 || fail "alice serve did not start"

log "starting bob (initiator, seeds the conversation)..."
$AR serve --home "$BOB_HOME" --server "$SERVER_WS" \
	--on-message "$HANDLER" --max-turns 2 --handler-timeout 100 --json \
	--seed "Hi! Name one planet of the solar system." --to "$ALICE_PK" \
	>"$BOB_LOG" 2>&1 &
BOB_SERVE_PID=$!

# Each `done` is at most ~3 sequential LLM replies away (90s handler timeout each).
log "waiting for the conversation to complete (LLM latency — be patient)..."
wait_for "$BOB_LOG" '"type":"done"' 150 || fail "bob did not reach --max-turns (done)"
pass "bob completed his 2 turns"
wait_for "$ALICE_LOG" '"type":"done"' 150 || fail "alice did not reach --max-turns (done)"
pass "alice completed her 2 turns"

# serve processes exit on their own after `done`
wait "$ALICE_SERVE_PID" 2>/dev/null || true
wait "$BOB_SERVE_PID" 2>/dev/null || true
ALICE_SERVE_PID=""
BOB_SERVE_PID=""

# ── Assertions on the NDJSON event streams ────────────────────────────────────
for who in alice bob; do
	LOG_FILE="$WORK_DIR/${who}_serve.jsonl"
	replied=$(grep -c '"type":"replied"' "$LOG_FILE" || true)
	[[ "$replied" -eq 2 ]] || fail "$who: expected 2 replied events, got $replied"
	grep -q '"type":"received"' "$LOG_FILE" || fail "$who: no received event"
	for bad in handler_error send_error no_reply; do
		grep -q "\"type\":\"$bad\"" "$LOG_FILE" && fail "$who: unexpected $bad event"
	done
done
pass "both sides: 2 replies each, messages received, no handler/send errors"

# ── Print the conversation for human inspection ───────────────────────────────
echo "" >&2
log "conversation transcript:"
log "--- bob (initiator) ---"
grep -E '"type":"(received|replied)"' "$BOB_LOG" >&2 || true
log "--- alice (responder) ---"
grep -E '"type":"(received|replied)"' "$ALICE_LOG" >&2 || true

echo "" >&2
log "Live E2E passed ✓ (2 real Claude agents, E2E-encrypted relay, OAuth session)"
