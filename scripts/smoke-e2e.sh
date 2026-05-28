#!/usr/bin/env bash
# smoke-e2e.sh — end-to-end smoke test using real CLI processes
# Usage: bash scripts/smoke-e2e.sh [--server-port PORT]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/agentroom-smoke.XXXXXX)"
SERVER_PORT="${1:-0}" # 0 = let OS assign; we'll parse the actual port
SERVER_PID=""
LISTEN_PID=""

cleanup() {
	[[ -n "$LISTEN_PID" ]] && kill "$LISTEN_PID" 2>/dev/null || true
	[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() { echo "[smoke] $*" >&2; }
fail() {
	echo "[smoke] FAIL: $*" >&2
	exit 1
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

# ── Generate test .env ────────────────────────────────────────────────────────
log "generating test .env..."
TEST_SECRET="$(openssl rand -hex 32)"
TEST_PORT=8900
# Find a free port
for p in $(seq 8900 8950); do
	if ! ss -tlnp 2>/dev/null | grep -q ":$p "; then
		TEST_PORT=$p
		break
	fi
done

SERVER_LOG="$WORK_DIR/server.log"
SERVER_DB="$WORK_DIR/agentroom.db"

# ── Start server ──────────────────────────────────────────────────────────────
log "starting server on :$TEST_PORT ..."
HMAC_SECRET="$TEST_SECRET" PORT="$TEST_PORT" AGENTROOM_DB="$SERVER_DB" \
	node "$REPO_ROOT/packages/server/dist/index.js" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 20); do
	sleep 0.2
	if curl -sf "http://localhost:$TEST_PORT/health" >/dev/null 2>&1; then
		break
	fi
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		fail "server process died. Log: $(cat "$SERVER_LOG")"
	fi
	if [[ $i -eq 20 ]]; then
		fail "server did not start in time. Log: $(cat "$SERVER_LOG")"
	fi
done
log "server ready"

SERVER_WS="ws://localhost:$TEST_PORT/ws"
ALICE_HOME="$WORK_DIR/alice"
BOB_HOME="$WORK_DIR/bob"

# ── Init identities ───────────────────────────────────────────────────────────
log "initializing alice and bob identities..."
node "$AGENTROOM_BIN" init --home "$ALICE_HOME" >/dev/null
node "$AGENTROOM_BIN" init --home "$BOB_HOME" >/dev/null

ALICE_PK=$(node "$AGENTROOM_BIN" whoami --home "$ALICE_HOME" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.ed25519_pk)")

# ── Invite flow ───────────────────────────────────────────────────────────────
log "alice creates invite..."
INVITE_URL=$(node "$AGENTROOM_BIN" invite create --home "$ALICE_HOME" --server "$SERVER_WS" | grep "^agentroom://")
[[ -n "$INVITE_URL" ]] || fail "no invite URL captured"

log "bob accepts invite..."
node "$AGENTROOM_BIN" invite accept "$INVITE_URL" --home "$BOB_HOME" --server "$SERVER_WS" >/dev/null

sleep 0.5 # wait for SESSION_ACK round-trip

# ── Alice listens ─────────────────────────────────────────────────────────────
ALICE_LOG="$WORK_DIR/alice_listen.jsonl"
log "alice listening (background)..."
node "$AGENTROOM_BIN" listen --home "$ALICE_HOME" --server "$SERVER_WS" --json >"$ALICE_LOG" 2>&1 &
LISTEN_PID=$!
sleep 0.3

# ── Bob sends ─────────────────────────────────────────────────────────────────
log "bob sends message to alice..."
node "$AGENTROOM_BIN" send "$ALICE_PK" "hello from bob smoke test" --home "$BOB_HOME" --server "$SERVER_WS"

# ── Verify delivery ───────────────────────────────────────────────────────────
log "waiting for delivery (up to 5s)..."
for i in $(seq 1 25); do
	sleep 0.2
	if grep -q "hello from bob smoke test" "$ALICE_LOG" 2>/dev/null; then
		log "✓ message delivered"
		exit 0
	fi
done

fail "message not received within 5s. Alice log: $(cat "$ALICE_LOG" 2>/dev/null || echo '(empty)')"
