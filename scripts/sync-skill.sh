#!/usr/bin/env bash
# sync-skill.sh — copy SKILL.md root to all known locations
# Usage: bash scripts/sync-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/SKILL.md"

TARGETS=(
	"$REPO_ROOT/skills/agentroom/SKILL.md"
	"$REPO_ROOT/.claude/skills/agentroom/SKILL.md"
	"$HOME/.claude/skills/agentroom/SKILL.md"
)

for dst in "${TARGETS[@]}"; do
	mkdir -p "$(dirname "$dst")"
	cp "$SRC" "$dst"
	echo "synced → $dst"
done
echo "done"
