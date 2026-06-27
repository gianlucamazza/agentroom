#!/usr/bin/env bash
# agentroom `serve` handler backed by any OpenAI-compatible chat-completions API
# — OpenAI, DeepSeek, Groq, OpenRouter, a local Ollama, etc. Just point LLM_BASE_URL
# at the endpoint.
#
# Reads the incoming agentroom message on stdin and prints a one-sentence reply on
# stdout — the exact contract `agentroom serve --on-message` expects.
#
#   LLM_API_KEY=$OPENAI_API_KEY \
#     agentroom serve --server "$URL" --on-message ./scripts/openai-compatible-handler.sh --json
#
# Env:
#   LLM_API_KEY          (required) bearer token; falls back to OPENAI_API_KEY
#   LLM_BASE_URL         API base (default: https://api.openai.com/v1)
#   LLM_MODEL            model id   (default: gpt-4.1-mini)
#   LLM_MAX_TOKENS       output cap (default: 120)
#   LLM_HANDLER_TIMEOUT  per-message timeout in seconds (default: 90)
#
# Uses `max_tokens` — the parameter shared by every OpenAI-compatible endpoint
# (OpenAI non-reasoning models, DeepSeek, Groq, OpenRouter, Ollama). OpenAI's
# o-series reasoning models instead want `max_completion_tokens`; for those, set
# LLM_MAX_TOKENS to a high value or use a non-reasoning model (out of scope here).
#
# Privacy: like every LLM handler, the peer's plaintext message is sent to the
# configured provider. The agentroom relay stays blind; the endpoint does not.
#
# No retry loop on purpose: in tests a failure should fail loudly, not be masked.
set -uo pipefail

command -v jq >/dev/null 2>&1 || {
	echo "openai-handler: jq is required" >&2
	exit 1
}
command -v curl >/dev/null 2>&1 || {
	echo "openai-handler: curl is required" >&2
	exit 1
}
# LLM_API_KEY is the canonical name (provider-neutral); accept OPENAI_API_KEY as a
# fallback so the standard OpenAI env var works out of the box.
LLM_API_KEY="${LLM_API_KEY:-${OPENAI_API_KEY:-}}"
: "${LLM_API_KEY:?openai-handler: LLM_API_KEY (or OPENAI_API_KEY) is required}"

BASE_URL="${LLM_BASE_URL:-https://api.openai.com/v1}"
MODEL="${LLM_MODEL:-gpt-4.1-mini}"
MAX_TOKENS="${LLM_MAX_TOKENS:-120}"
TIMEOUT="${LLM_HANDLER_TIMEOUT:-90}"

msg="$(cat)"
[ -z "$msg" ] && exit 1

system="You are an agent in an agentroom peer-to-peer chat. Reply to your peer's message with exactly ONE short sentence, nothing else."

# Build the request body with jq so the untrusted message is safely JSON-escaped.
body="$(jq -n --arg model "$MODEL" --arg sys "$system" --arg msg "$msg" --argjson max "$MAX_TOKENS" '{
  model: $model,
  max_tokens: $max,
  temperature: 0.7,
  messages: [
    { role: "system", content: $sys },
    { role: "user", content: $msg }
  ]
}')"

resp="$(timeout "$TIMEOUT" curl -sS -X POST "$BASE_URL/chat/completions" \
	-H "Authorization: Bearer $LLM_API_KEY" \
	-H "Content-Type: application/json" \
	-d "$body" 2>/dev/null)" || exit 1

reply="$(printf '%s' "$resp" | jq -r '.choices[0].message.content // empty' 2>/dev/null)"
if [ -z "$reply" ]; then
	err="$(printf '%s' "$resp" | jq -r '.error.message // empty' 2>/dev/null)"
	echo "openai-handler: empty reply${err:+ — $err}" >&2
	exit 1
fi

printf '%s\n' "$reply"
