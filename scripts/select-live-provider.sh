#!/usr/bin/env bash
# Shared LLM-provider selection for the live E2E scripts (sourced, not executed).
#
# Picks a provider by available credentials, in priority order, then probes it
# with one tiny call. On success it sets the global $HANDLER (and exports the
# provider env the handler needs); if no provider is available it calls skip()
# so the live test is a no-op (exit 0) rather than a failure.
#
# Requires the caller to have already defined skip()/log()/pass() and REPO_ROOT.
#
# Priority (override with AGENTROOM_FORCE_PROVIDER=anthropic|openai|deepseek):
#   1. Anthropic  — `claude` CLI authenticated (Claude Code OAuth or ANTHROPIC_API_KEY)
#   2. OpenAI     — OPENAI_API_KEY
#   3. DeepSeek   — DEEPSEEK_API_KEY
#   4. Custom     — LLM_API_KEY + LLM_BASE_URL set directly

# Probe an OpenAI-compatible provider by running the handler with a trivial
# message (reuses the curl logic — no duplication). Relies on LLM_* already set.
_probe_openai_compat() {
	echo "Reply with the single word: ok" |
		timeout 60 bash "$REPO_ROOT/scripts/openai-compatible-handler.sh" >/dev/null 2>&1
}

# HANDLER is a global consumed by the sourcing script, not used within this file.
# shellcheck disable=SC2034
select_live_provider() {
	local force="${AGENTROOM_FORCE_PROVIDER:-}"

	# 1) Anthropic via the claude CLI
	if [[ -z "$force" || "$force" == anthropic ]] && command -v claude >/dev/null 2>&1; then
		log "probing claude auth (one tiny haiku call)..."
		local probe
		if probe="$(timeout 60 claude -p "Reply with the single word: ok" --model haiku </dev/null 2>/dev/null)" &&
			[[ -n "$probe" ]]; then
			HANDLER="$REPO_ROOT/scripts/claude-handler.sh"
			pass "provider: anthropic (claude CLI)"
			return 0
		fi
		[[ "$force" == anthropic ]] && skip "AGENTROOM_FORCE_PROVIDER=anthropic but claude probe failed"
	fi

	# 2) OpenAI
	if [[ -z "$force" || "$force" == openai ]] && [[ -n "${OPENAI_API_KEY:-}" ]]; then
		export LLM_API_KEY="$OPENAI_API_KEY"
		export LLM_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
		export LLM_MODEL="${OPENAI_MODEL:-gpt-4.1-mini}"
		log "probing openai ($LLM_MODEL)..."
		if _probe_openai_compat; then
			HANDLER="$REPO_ROOT/scripts/openai-compatible-handler.sh"
			pass "provider: openai ($LLM_MODEL)"
			return 0
		fi
		[[ "$force" == openai ]] && skip "AGENTROOM_FORCE_PROVIDER=openai but probe failed"
	fi

	# 3) DeepSeek
	if [[ -z "$force" || "$force" == deepseek ]] && [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
		export LLM_API_KEY="$DEEPSEEK_API_KEY"
		export LLM_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}"
		export LLM_MODEL="${DEEPSEEK_MODEL:-deepseek-v4-flash}"
		log "probing deepseek ($LLM_MODEL)..."
		if _probe_openai_compat; then
			HANDLER="$REPO_ROOT/scripts/openai-compatible-handler.sh"
			pass "provider: deepseek ($LLM_MODEL)"
			return 0
		fi
		[[ "$force" == deepseek ]] && skip "AGENTROOM_FORCE_PROVIDER=deepseek but probe failed"
	fi

	# 4) Custom OpenAI-compatible endpoint (user-provided LLM_API_KEY + LLM_BASE_URL)
	if [[ -z "$force" ]] && [[ -n "${LLM_API_KEY:-}" && -n "${LLM_BASE_URL:-}" ]]; then
		export LLM_MODEL="${LLM_MODEL:-gpt-4.1-mini}"
		log "probing custom endpoint ($LLM_BASE_URL, $LLM_MODEL)..."
		if _probe_openai_compat; then
			HANDLER="$REPO_ROOT/scripts/openai-compatible-handler.sh"
			pass "provider: custom ($LLM_BASE_URL, $LLM_MODEL)"
			return 0
		fi
	fi

	skip "no LLM provider available — set up claude (OAuth or ANTHROPIC_API_KEY), or set OPENAI_API_KEY / DEEPSEEK_API_KEY / LLM_API_KEY+LLM_BASE_URL"
}
