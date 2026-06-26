#!/usr/bin/env bash
# Capture a REAL multi-runtime exchange and write demo/transcript.json.
#
# Story: colleagues on one project whose coding agents talk over agentroom. The
# words shown on the landing are genuine coding-agent CLI output: this script
# feeds the real handlers (scripts/{claude,codex,opencode}-handler.sh) the
# running conversation and records each one-sentence reply. agentroom only
# routes ciphertext, so the *content* is exactly what each agent's CLI produces.
#
#   bash demo/capture.sh            # uses the real claude / codex / opencode CLIs
#   bash demo/capture.sh --dry-run  # print turns without writing transcript.json
#
# Requires: `claude` (Claude Code) and `codex` (Codex). `opencode` is best-effort
# (needs its local server on :4096) — if it is unavailable, Carol's seeded line
# is kept. After capturing, re-render: vhs demo/hero.tape && vhs demo/developers.tape
#
# Redaction: this path never touches public keys, invite URLs, or tunnel hosts.
# The seed/roster/labels stay fixed; only message replies are overwritten.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLAUDE_H="$ROOT/scripts/claude-handler.sh"
CODEX_H="$ROOT/scripts/codex-handler.sh"
OPENCODE_H="$ROOT/scripts/opencode-handler.sh"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

for h in "$CLAUDE_H" "$CODEX_H" "$OPENCODE_H"; do
	[ -x "$h" ] || {
		echo "capture: missing handler $h" >&2
		exit 1
	}
done
command -v claude >/dev/null || {
	echo "capture: 'claude' CLI required" >&2
	exit 1
}
command -v codex >/dev/null || {
	echo "capture: 'codex' CLI required" >&2
	exit 1
}
HAVE_OPENCODE=1
command -v opencode >/dev/null || {
	echo "capture: 'opencode' CLI not found — keeping Carol's seeded line" >&2
	HAVE_OPENCODE=0
}

# Alice's opening (fixed; mirrors transcript.json "seed").
SEED="Bob, can your agent add the invite-fallback regression test on the auth branch?"

# Turn plan — must match transcript.json "messages" order. Each turn is a real
# coding-agent CLI reply; briefs are tightly scoped (English, length, intent) so
# the captured wording stays clean and on-brand. Curate transcript.json if a
# reply comes out off.
EN="Respond in English only, no Italian, no preamble."
WHO=(Bob Alice Bob Alice Carol Alice)
HANDLERS=("$CODEX_H" "$CLAUDE_H" "$CODEX_H" "$CLAUDE_H" "$OPENCODE_H" "$CLAUDE_H")
BRIEFS=(
	"$EN You are Bob's coding agent. A teammate asked: '$SEED'. Reply in ONE sentence under 12 words: you added the fallback test, and give the exact command 'npm test -- invite'."
	"$EN You are Alice's coding agent reviewing the change. Reply in ONE sentence under 12 words asking to also confirm an explicit --server flag still takes precedence."
	"$EN You are Bob's coding agent. Reply in ONE sentence under 8 words: it is covered and the suite is green."
	"$EN You are Alice's coding agent. Reply in ONE sentence under 15 words asking your teammate Carol's agent to refactor the invite helper while you are all here."
	"$EN You are Carol's coding agent. Reply in ONE sentence under 9 words: you refactored the invite helper and lint is clean."
	"$EN You are Alice's coding agent. Reply in ONE sentence under 6 words thanking both teammates and merging."
)

REPLIES=()
for i in "${!WHO[@]}"; do
	who="${WHO[$i]}"
	brief="${BRIEFS[$i]}"
	handler="${HANDLERS[$i]}"
	echo "── turn $((i + 1)) · $who ───────────────" >&2

	if [ "$handler" = "$OPENCODE_H" ] && [ "$HAVE_OPENCODE" = 0 ]; then
		echo "   (skipped — opencode unavailable, keeping seeded line)" >&2
		REPLIES+=("")
		continue
	fi

	reply="$(printf '%s' "$brief" | "$handler" 2>/dev/null | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" || reply=""
	if [ -z "$reply" ]; then
		if [ "$handler" = "$OPENCODE_H" ]; then
			echo "   (empty — keeping Carol's seeded line)" >&2
			REPLIES+=("")
			continue
		fi
		echo "capture: empty reply on turn $((i + 1)) ($who)" >&2
		exit 1
	fi
	echo "   $reply" >&2
	REPLIES+=("$reply")
done

if [ "$DRY" = 1 ]; then
	echo "(dry-run) not writing transcript.json" >&2
	exit 0
fi

# Merge real replies into transcript.json (empty reply → keep existing text).
SEED="$SEED" node - "$HERE/transcript.json" "${REPLIES[@]}" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [path, ...replies] = process.argv.slice(2);
const t = JSON.parse(readFileSync(path, "utf8"));
t.seed = process.env.SEED;
t.messages = t.messages.map((m, i) => (replies[i] ? { ...m, text: replies[i] } : m));
writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
const kept = replies.filter((r) => !r).length;
console.error(`capture: wrote ${replies.length - kept} real replies` + (kept ? `, kept ${kept} seeded` : ""));
NODE

echo "capture: done — re-render with 'vhs demo/hero.tape && vhs demo/developers.tape'" >&2
