#!/usr/bin/env bash
# agentroom `serve` handler backed by the local OpenCode server (GLM).
#
# Reads the incoming agentroom message on stdin and prints OpenCode's one-line
# reply on stdout — the exact contract `agentroom serve --on-message` expects.
#
#   agentroom serve --server "$URL" --on-message ./scripts/opencode-handler.sh --json
#
# Why a wrapper (and not `opencode run` directly): a bare `opencode run` in a
# pipe emits no assistant text on stdout. Attaching to the already-running
# headless server (`--attach`) does: the reply goes to stdout, the banner to
# stderr. We discard stderr and forward stdout. See crossagent-simulation-notes.
#
# Each message is a fresh OpenCode session (stateless) — no cross-conversation
# bleed. For stateful chat, thread a per-peer session id via $AGENTROOM_FROM.
set -uo pipefail

OC_SERVER="${OPENCODE_ATTACH:-http://localhost:4096}"

# OPENCODE_SERVER_PASSWORD lives in server.env; non-interactive shells (like the
# one `serve` spawns) don't read ~/.bashrc, so load it explicitly or the attach
# fails with a confusing auth / "Session not found" error.
if [ -f "$HOME/.config/opencode/server.env" ]; then
	set -a
	. "$HOME/.config/opencode/server.env"
	set +a
fi

msg="$(cat)"
[ -z "$msg" ] && exit 1

# Transparent, contextualized prompt: GLM rejects "automation runner / repeat
# character-for-character" framings as prompt injection (see memory notes).
prompt="Sei un agente in una chat agentroom (test locale in sandbox). Rispondi in una sola frase, in italiano, al messaggio del tuo interlocutore: ${msg}"

# No --dir on purpose: a chat reply needs no project context, and pointing --dir
# at a tmp/sandbox dir makes `opencode run --attach` hang. Set OPENCODE_DIR to
# override if you do want the model to see a working tree.
dir_args=()
[ -n "${OPENCODE_DIR:-}" ] && dir_args=(--dir "$OPENCODE_DIR")

# The GLM backend occasionally returns an empty completion under load — retry a
# couple of times before giving up (an empty reply makes `serve` send nothing).
reply=""
for attempt in 1 2 3; do
	reply="$(timeout 120 opencode run --attach "$OC_SERVER" "${dir_args[@]}" "$prompt" 2>/dev/null)" || true
	[ -n "$reply" ] && break
	sleep 3
done
[ -z "$reply" ] && exit 1

printf '%s\n' "$reply"
