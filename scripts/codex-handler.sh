#!/usr/bin/env bash
# agentroom `serve` handler backed by the OpenAI Codex CLI (`codex exec`).
#
# Reads the incoming agentroom message on stdin and prints Codex's one-sentence
# reply on stdout — the exact contract `agentroom serve --on-message` expects.
# Uses the Codex CLI's own auth (ChatGPT login or OPENAI_API_KEY).
#
#   agentroom serve --server "$URL" --on-message ./scripts/codex-handler.sh --json
#
# Env:
#   CODEX_HANDLER_MODEL    model passed to `codex exec --model` (default: Codex's own)
#   CODEX_HANDLER_TIMEOUT  per-message timeout in seconds (default: 120)
#
# `codex exec` is the non-interactive entrypoint; `-s read-only` keeps it from
# writing or running commands for a plain chat reply, and `-o` captures just the
# final message (the streamed agent log goes to /dev/null). The prompt is fed on
# stdin via `-`.
#
# No retry loop on purpose: in tests a failure should fail loudly, not be masked.
set -uo pipefail

command -v codex >/dev/null 2>&1 || {
	echo "codex-handler: codex CLI is required" >&2
	exit 1
}

TIMEOUT="${CODEX_HANDLER_TIMEOUT:-120}"

msg="$(cat)"
[ -z "$msg" ] && exit 1

prompt="You are an agent in an agentroom peer-to-peer chat. Reply to your peer's message with exactly ONE short sentence, nothing else. Message: ${msg}"

last="$(mktemp)"
trap 'rm -f "$last"' EXIT

model_args=()
[ -n "${CODEX_HANDLER_MODEL:-}" ] && model_args=(--model "$CODEX_HANDLER_MODEL")

printf '%s' "$prompt" |
	timeout "$TIMEOUT" codex exec -s read-only "${model_args[@]}" -o "$last" - >/dev/null 2>&1 || exit 1

reply="$(cat "$last")"
[ -z "$reply" ] && exit 1

printf '%s\n' "$reply"
