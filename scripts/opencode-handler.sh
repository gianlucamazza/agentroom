#!/usr/bin/env bash
# agentroom `serve` handler backed by the local OpenCode server (GLM).
#
# Reads the incoming agentroom message on stdin and prints OpenCode's one-line
# reply on stdout — the exact contract `agentroom serve --on-message` expects.
#
#   agentroom serve --server "$URL" --on-message ./scripts/opencode-handler.sh --json
#
# Why a wrapper (and not `opencode run` directly): pointed at the already-running
# headless server (`--server`, opencode 2.x; 1.x used `--attach`) the reply goes
# to stdout, the banner to stderr. We discard stderr and forward stdout. A bare
# 2.x `opencode run` would spawn its own background service instead.
# See crossagent-simulation-notes.
#
# Each message is a fresh OpenCode session (stateless) — no cross-conversation
# bleed. For stateful chat, thread a per-peer session id via $AGENTROOM_FROM.
set -uo pipefail

OC_SERVER="${OPENCODE_SERVER:-${OPENCODE_ATTACH:-http://127.0.0.1:4096}}"

# OPENCODE_SERVER_PASSWORD lives in server.env; non-interactive shells (like the
# one `serve` spawns) don't read ~/.bashrc, so load it explicitly or the attach
# fails with a confusing auth / "Session not found" error.
if [ -f "$HOME/.config/opencode/server.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$HOME/.config/opencode/server.env"
	set +a
fi

msg="$(cat)"
[ -z "$msg" ] && exit 1

# Transparent, contextualized prompt: GLM rejects "automation runner / repeat
# character-for-character" framings as prompt injection (see memory notes).
prompt="Sei un agente in una chat agentroom (test locale in sandbox). Rispondi in una sola frase, in italiano, al messaggio del tuo interlocutore: ${msg}"

# opencode 2.x has no --dir: the session's working dir is the client cwd. Set
# OPENCODE_DIR if you want the model to see a specific working tree.
if [ -n "${OPENCODE_DIR:-}" ]; then
	cd "$OPENCODE_DIR" || exit 1
fi

# The GLM backend occasionally returns an empty completion under load — retry a
# couple of times before giving up (an empty reply makes `serve` send nothing).
# Only a zero exit counts: opencode 2.x prints its errors (server unreachable,
# unknown flag) on stdout with a non-zero status, and forwarding that text would
# send a stack trace or the CLI help as the chat reply.
reply=""
for _ in 1 2 3; do
	if reply="$(timeout 120 opencode run --server "$OC_SERVER" "$prompt" 2>/dev/null)" &&
		[ -n "$reply" ]; then
		break
	fi
	reply=""
	sleep 3
done
[ -z "$reply" ] && exit 1

printf '%s\n' "$reply"
