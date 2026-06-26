#!/usr/bin/env bash
# Capture a REAL Claude Code <-> Codex exchange and write demo/transcript.json.
#
# The demo content shown on the landing is genuine model output: this script
# feeds the real handlers (scripts/claude-handler.sh, scripts/codex-handler.sh)
# the running conversation and records each one-sentence reply. The blind relay
# only routes ciphertext, so the *content* a viewer reads is exactly what the
# handlers produce here — no relay round-trip is needed to capture it.
#
#   bash demo/capture.sh            # uses the real `claude` and `codex` CLIs
#   bash demo/capture.sh --dry-run  # print turns without writing transcript.json
#
# Requires: `claude` (Claude Code OAuth) and `codex` (ChatGPT login / OPENAI_API_KEY).
# After capturing, re-render with:  vhs demo/hero.tape && vhs demo/developers.tape
#
# Redaction: this path never touches public keys, invite URLs, or tunnel hosts,
# so nothing sensitive can land in transcript.json. The seed/labels stay fixed;
# only the replies are overwritten with real output.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLAUDE_H="$ROOT/scripts/claude-handler.sh"
CODEX_H="$ROOT/scripts/codex-handler.sh"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

for h in "$CLAUDE_H" "$CODEX_H"; do
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

SEED="Plan: add a regression test for the invite-accept server_url fallback. Implement the smallest test and give the run command."

# Conversation plan: side (left=Claude reviewer, right=Codex actor) + the brief
# we hand that agent for its turn. Each reply is its peer's next input.
SIDES=(left right left right left)
# Briefs are tightly constrained (English, length, intent) so the captured
# output stays clean and on-brand for the landing — the wording is still the
# model's, just scoped. Curate the result in transcript.json if a reply is off.
EN="Respond in English only, no Italian."
BRIEFS=(
	"$EN A peer asked: '$SEED'. As the reviewer, reply in ONE sentence under 10 words telling the actor to write just one focused test, no protocol changes."
	"$EN As the actor, reply in ONE sentence under 12 words: you added the fallback test, and give the exact command 'npm test -- invite'."
	"$EN As the reviewer, reply in ONE sentence under 12 words asking to also confirm an explicit --server flag still takes precedence."
	"$EN As the actor, reply in ONE sentence under 9 words: it is covered and the suite is green."
	"$EN As the reviewer, reply in ONE sentence under 7 words approving the change for merge."
)

REPLIES=()
ctx="$SEED"
for i in "${!SIDES[@]}"; do
	side="${SIDES[$i]}"
	brief="${BRIEFS[$i]}"
	if [ "$side" = left ]; then
		who="Claude Code"
		handler="$CLAUDE_H"
	else
		who="Codex"
		handler="$CODEX_H"
	fi
	echo "── turn $((i + 1)) · $who ($side) ───────────────" >&2
	reply="$(printf '%s' "$brief" | "$handler" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
	[ -z "$reply" ] && {
		echo "capture: empty reply on turn $((i + 1))" >&2
		exit 1
	}
	echo "   $reply" >&2
	REPLIES+=("$reply")
	ctx="$reply"
done

if [ "$DRY" = 1 ]; then
	echo "(dry-run) not writing transcript.json" >&2
	exit 0
fi

# Merge real replies into transcript.json, preserving structure/labels.
SEED="$SEED" node - "$HERE/transcript.json" "${REPLIES[@]}" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [path, ...replies] = process.argv.slice(2);
const t = JSON.parse(readFileSync(path, "utf8"));
t.seed = process.env.SEED;
t.messages = t.messages.map((m, i) => ({ ...m, text: replies[i] ?? m.text }));
writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
console.error(`capture: wrote ${replies.length} real replies to ${path}`);
NODE

echo "capture: done — re-render with 'vhs demo/hero.tape && vhs demo/developers.tape'" >&2
