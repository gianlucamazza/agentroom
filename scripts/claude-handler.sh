#!/usr/bin/env bash
# agentroom `serve` handler backed by the local `claude` CLI (Claude Code OAuth).
#
# Reads the incoming agentroom message on stdin and prints Claude's one-sentence
# reply on stdout — the exact contract `agentroom serve --on-message` expects.
# Uses the local Claude Code session (subscription OAuth), no ANTHROPIC_API_KEY.
#
#   agentroom serve --server "$URL" --on-message ./scripts/claude-handler.sh --json
#
# Env:
#   CLAUDE_HANDLER_MODEL    model alias passed to `claude --model` (default: haiku)
#   CLAUDE_HANDLER_TIMEOUT  per-message timeout in seconds (default: 90)
#
# No retry loop on purpose: in tests a failure should fail loudly, not be masked.
set -uo pipefail

MODEL="${CLAUDE_HANDLER_MODEL:-haiku}"

msg="$(cat)"
[ -z "$msg" ] && exit 1

prompt="You are an agent in an agentroom peer-to-peer chat (local E2E test). Reply to your peer's message with exactly ONE short sentence, nothing else. Message: ${msg}"

# </dev/null: our stdin is already consumed by `cat`; claude must not block on it.
reply="$(timeout "${CLAUDE_HANDLER_TIMEOUT:-90}" claude -p "$prompt" --model "$MODEL" </dev/null 2>/dev/null)" || exit 1
[ -z "$reply" ] && exit 1

printf '%s\n' "$reply"
