#!/usr/bin/env bash
# e2e-live-tunnel.sh — live E2E over a REAL cloudflared tunnel: `room open` hosts
# relay + public wss URL + invite + auto-reply in one process (Alice); a second
# Claude agent (Bob) joins through the PUBLIC trycloudflare URL embedded in the
# invite. Same Claude Code OAuth handler as e2e-live.sh — 3 LLM calls on haiku.
#
# Slower and network-dependent (tunnel establishment, ephemeral trycloudflare
# DNS): expect ~1-2 min. Local-only: auto-SKIPs (exit 0) when `claude` is
# missing/unauthenticated or AGENTROOM_E2E_LIVE=0. After the auth probe passes,
# every error is a FAIL — including tunnel failures (that's what this tests).
#
# Usage: bash scripts/e2e-live-tunnel.sh   (or: npm run e2e:live:tunnel)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/agentroom-live-tunnel.XXXXXX)"
HOST_PID=""
BOB_SERVE_PID=""

cleanup() {
	# room open SIGTERMs its own children (server + cloudflared) on shutdown
	[[ -n "$BOB_SERVE_PID" ]] && kill "$BOB_SERVE_PID" 2>/dev/null || true
	[[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() { echo "[tunnel] $*" >&2; }
pass() { echo "[tunnel] ✓ $*" >&2; }
skip() {
	echo "[tunnel] SKIP: $*" >&2
	exit 0
}
fail() {
	echo "[tunnel] FAIL: $*" >&2
	echo "[tunnel] --- host (alice) log ---" >&2
	cat "${HOST_LOG:-/dev/null}" 2>/dev/null >&2 || true
	echo "[tunnel] --- bob log ---" >&2
	cat "${BOB_LOG:-/dev/null}" 2>/dev/null >&2 || true
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

# Extract a field from the first NDJSON event of a given type in a log file.
json_field() {
	local file="$1" type="$2" field="$3"
	grep "\"type\":\"$type\"" "$file" | head -1 | node -e "
		const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
		process.stdout.write(String(d['$3'] ?? ''));
	" "$field" 2>/dev/null || true
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

if [[ ! -f "$REPO_ROOT/packages/cli/dist/index.js" ]]; then
	log "building..."
	cd "$REPO_ROOT" && npm run build >/dev/null 2>&1
fi

AGENTROOM_BIN="$REPO_ROOT/packages/cli/dist/index.js"
[[ -f "$AGENTROOM_BIN" ]] || fail "CLI not found at $AGENTROOM_BIN"
AR="node $AGENTROOM_BIN"
HANDLER="$REPO_ROOT/scripts/claude-handler.sh"
[[ -x "$HANDLER" ]] || fail "handler not executable at $HANDLER"

# Reuse the cloudflared already cached under the default config home (the
# isolated --home tmpdirs would otherwise re-download ~40MB on every run).
DEFAULT_CF="$HOME/.config/agentroom/bin/cloudflared"
if [[ -z "${AGENTROOM_CLOUDFLARED:-}" && -x "$DEFAULT_CF" ]]; then
	export AGENTROOM_CLOUDFLARED="$DEFAULT_CF"
	log "reusing cached cloudflared: $DEFAULT_CF"
fi

TEST_PORT=8900
for p in $(seq 8900 8950); do
	if ! ss -tlnp 2>/dev/null | grep -q ":$p "; then
		TEST_PORT=$p
		break
	fi
done

ALICE_HOME="$WORK_DIR/alice"
BOB_HOME="$WORK_DIR/bob"

log "initializing alice and bob identities..."
$AR init --home "$ALICE_HOME" >/dev/null
$AR init --home "$BOB_HOME" >/dev/null

# ── Host: room open = relay + tunnel + invite + auto-reply in one process ─────
log "=== live conversation over a real cloudflared tunnel ==="
HOST_LOG="$WORK_DIR/host_room.jsonl"
BOB_LOG="$WORK_DIR/bob_serve.jsonl"

log "alice opens a tunneled room on :$TEST_PORT (cloudflared may take a while)..."
$AR room open --home "$ALICE_HOME" --port "$TEST_PORT" --db "$WORK_DIR/agentroom.db" \
	--on-message "$HANDLER" --max-turns 2 --handler-timeout 100 --json \
	>"$HOST_LOG" 2>&1 &
HOST_PID=$!

wait_for "$HOST_LOG" '"type":"tunnel"' 120 || fail "tunnel never established (network/cloudflared?)"
TUNNEL_WSS=$(json_field "$HOST_LOG" tunnel url)
[[ "$TUNNEL_WSS" == wss://* ]] || fail "no wss tunnel URL in tunnel event"

# The relay's own reachability probe gives up after ~25s, but trycloudflare DNS
# can lag longer — poll /health through the tunnel ourselves before declaring it dead.
TUNNEL_HTTPS="https://${TUNNEL_WSS#wss://}"
TUNNEL_HTTPS="${TUNNEL_HTTPS%/ws}"
if grep '"type":"tunnel"' "$HOST_LOG" | head -1 | grep -q '"reachable":true'; then
	pass "tunnel up and reachable: $TUNNEL_WSS"
else
	log "relay probe says unreachable — polling $TUNNEL_HTTPS/health (DNS may lag)..."
	reachable=""
	for _ in $(seq 1 45); do
		sleep 2
		if curl -sf --max-time 5 "$TUNNEL_HTTPS/health" >/dev/null 2>&1; then
			reachable=1
			break
		fi
	done
	[[ -n "$reachable" ]] || fail "tunnel URL not reachable after 90s ($TUNNEL_HTTPS)"
	pass "tunnel reachable after DNS propagation: $TUNNEL_WSS"
fi

wait_for "$HOST_LOG" '"type":"serving"' 15 || fail "host did not reach serving"
ALICE_PK=$(json_field "$HOST_LOG" serving pk)
[[ -n "$ALICE_PK" ]] || fail "no host pk in serving event"

wait_for "$HOST_LOG" '"type":"invite"' 15 || fail "host did not publish an invite"
INVITE_URL=$(json_field "$HOST_LOG" invite url)
[[ "$INVITE_URL" == agentroom://invite/* ]] || fail "no invite URL in invite event"
pass "host serving, invite published"

# ── Bob joins through the PUBLIC tunnel URL embedded in the invite ────────────
# Alice IS online (room open is serving), so the handshake must complete — no
# `|| true` here: an accept failure over the real tunnel is exactly a test failure.
log "bob accepts the invite via the public tunnel..."
$AR invite accept "$INVITE_URL" --home "$BOB_HOME" --json >/dev/null ||
	fail "invite accept over the tunnel failed"
pass "handshake completed through the tunnel"

log "bob joins the conversation (seeds, 2 turns per side, 3 LLM calls)..."
$AR serve --home "$BOB_HOME" --server "$TUNNEL_WSS" \
	--on-message "$HANDLER" --max-turns 2 --handler-timeout 100 --json \
	--seed "Hi! Name one moon of Jupiter." --to "$ALICE_PK" \
	>"$BOB_LOG" 2>&1 &
BOB_SERVE_PID=$!

log "waiting for the conversation to complete (tunnel + LLM latency)..."
wait_for "$BOB_LOG" '"type":"done"' 180 || fail "bob did not reach --max-turns (done)"
pass "bob completed his 2 turns"
wait_for "$HOST_LOG" '"type":"done"' 180 || fail "alice (host) did not reach --max-turns (done)"
pass "alice completed her 2 turns"

# Both processes exit on their own after `done` (host shuts down relay + tunnel)
wait "$BOB_SERVE_PID" 2>/dev/null || true
wait "$HOST_PID" 2>/dev/null || true
BOB_SERVE_PID=""
HOST_PID=""

# ── Assertions on the NDJSON event streams ────────────────────────────────────
for entry in "alice:$HOST_LOG" "bob:$BOB_LOG"; do
	who="${entry%%:*}"
	LOG_FILE="${entry#*:}"
	replied=$(grep -c '"type":"replied"' "$LOG_FILE" || true)
	[[ "$replied" -eq 2 ]] || fail "$who: expected 2 replied events, got $replied"
	grep -q '"type":"received"' "$LOG_FILE" || fail "$who: no received event"
	for bad in handler_error send_error no_reply invite_error tunnel_error; do
		grep -q "\"type\":\"$bad\"" "$LOG_FILE" && fail "$who: unexpected $bad event"
	done
done
pass "both sides: 2 replies each, messages received, no handler/send/tunnel errors"

# ── Print the conversation for human inspection ───────────────────────────────
echo "" >&2
log "conversation transcript:"
log "--- alice (host, via room open) ---"
grep -E '"type":"(received|replied)"' "$HOST_LOG" >&2 || true
log "--- bob (remote peer, via $TUNNEL_WSS) ---"
grep -E '"type":"(received|replied)"' "$BOB_LOG" >&2 || true

echo "" >&2
log "Live tunnel E2E passed ✓ (real cloudflared tunnel, 2 real Claude agents, OAuth session)"
