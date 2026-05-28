#!/usr/bin/env bash
# agentroom-setup.sh — idempotent first-run setup for agentroom
# Outputs JSON: { ready: true/false, pk, identity_path, server_url, error? }
# Exit 0 = ready, Exit 1 = not ready (see error field)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY_DIR="${AGENTROOM_HOME:-$HOME/.config/agentroom}"
SERVER_URL_FILE="$IDENTITY_DIR/server_url"

out_error() {
	printf '{"ready":false,"error":%s}\n' "$(printf '%s' "$1" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8').trim()))")"
	exit 1
}

out_ok() {
	local pk="$1" id_path="$2" srv="$3"
	printf '{"ready":true,"pk":%s,"identity_path":%s,"server_url":%s}\n' \
		"$(printf '%s' "$pk" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8').trim()))")" \
		"$(printf '%s' "$id_path" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8').trim()))")" \
		"$(printf '%s' "$srv" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8').trim()))")"
}

# ── 1. Check Node >= 22 ───────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
	out_error "Node.js not found. Install Node >= 22 (https://nodejs.org)"
fi
node_major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [[ "$node_major" -lt 22 ]]; then
	out_error "Node >= 22 required for node:sqlite (found $node_major)"
fi

# ── 2. Ensure CLI is installed ────────────────────────────────────────────────
AGENTROOM_BIN="$REPO_ROOT/packages/cli/dist/index.js"

if ! command -v agentroom >/dev/null 2>&1 && [[ ! -f "$AGENTROOM_BIN" ]]; then
	# Try to build and link
	if [[ ! -f "$REPO_ROOT/package.json" ]]; then
		out_error "agentroom repo not found at $REPO_ROOT. Clone the repo first."
	fi
	cd "$REPO_ROOT"
	BUILD_OUT="$(npm install 2>&1 && npm run build 2>&1)" || {
		out_error "Build failed: $(printf '%s' "$BUILD_OUT" | tail -5)"
	}
fi

# Resolve actual CLI runner
if command -v agentroom >/dev/null 2>&1; then
	CLI="agentroom"
elif [[ -f "$AGENTROOM_BIN" ]]; then
	CLI="node $AGENTROOM_BIN"
else
	out_error "CLI not found. Run: cd $REPO_ROOT && npm run build"
fi

# ── 3. Ensure .env exists with HMAC_SECRET ────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
	if [[ ! -f "$REPO_ROOT/.env.example" ]]; then
		out_error ".env.example not found at $REPO_ROOT"
	fi
	cp "$REPO_ROOT/.env.example" "$ENV_FILE"
	# Generate a strong HMAC_SECRET
	if command -v openssl >/dev/null 2>&1; then
		SECRET="$(openssl rand -hex 32)"
	else
		SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
	fi
	# Replace placeholder
	if [[ "$(uname)" == "Darwin" ]]; then
		sed -i '' "s/^HMAC_SECRET=.*/HMAC_SECRET=$SECRET/" "$ENV_FILE"
	else
		sed -i "s/^HMAC_SECRET=.*/HMAC_SECRET=$SECRET/" "$ENV_FILE"
	fi
fi

# Validate HMAC_SECRET is set in .env
if ! grep -qE '^HMAC_SECRET=.{32,}' "$ENV_FILE" 2>/dev/null; then
	out_error "HMAC_SECRET in $ENV_FILE is missing or too short (min 32 chars). Edit $ENV_FILE."
fi

# ── 4. Ensure identity exists ─────────────────────────────────────────────────
mkdir -p "$IDENTITY_DIR"
ID_FILE="$IDENTITY_DIR/identity.json"

if [[ ! -f "$ID_FILE" ]]; then
	$CLI init --home "$IDENTITY_DIR" >/dev/null 2>&1 || true
fi

if [[ ! -f "$ID_FILE" ]]; then
	out_error "Failed to create identity at $ID_FILE. Run: agentroom init --home $IDENTITY_DIR"
fi

# ── 5. Read public key and server URL ─────────────────────────────────────────
PK="$($CLI whoami --home "$IDENTITY_DIR" 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.ed25519_pk)")"
if [[ -z "$PK" ]]; then
	out_error "Could not read public key from $ID_FILE"
fi

# Server URL: from env, from file, or empty
SRV="${AGENTROOM_SERVER_URL:-}"
if [[ -z "$SRV" ]] && [[ -f "$SERVER_URL_FILE" ]]; then
	SRV="$(cat "$SERVER_URL_FILE")"
fi
SRV="${SRV:-}"

# ── 6. Probe server health (skippable with --no-probe) ───────────────────────
NO_PROBE=false
for arg in "$@"; do [[ "$arg" == "--no-probe" ]] && NO_PROBE=true; done

if [[ "$NO_PROBE" == false ]] && [[ -n "$SRV" ]]; then
	HTTP_BASE="${SRV/\/ws/}"
	HTTP_BASE="${HTTP_BASE/wss:\/\//https://}"
	HTTP_BASE="${HTTP_BASE/ws:\/\//http://}"
	if ! curl -fsS --max-time 3 "$HTTP_BASE/health" >/dev/null 2>&1; then
		out_error "Server unreachable at $HTTP_BASE/health. Pass --no-probe to skip."
	fi
fi

out_ok "$PK" "$ID_FILE" "$SRV"
