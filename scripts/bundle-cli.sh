#!/usr/bin/env bash
# Build the standalone single-file CLI → bin/agentroom (self-contained, Node ≥22 only).
# Committed to the repo so the Claude Code plugin can ship it on PATH with zero install.
# Run after changing CLI/SDK/protocol/server source. CI verifies it stays in sync.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Workspace deps must be built first (bundle pulls their src via noExternal anyway,
# but protocol/sdk/server dist are referenced by the dev build + types).
npm run build >/dev/null

# Produce bin/agentroom.js
npx --prefix "$REPO_ROOT" tsup --config packages/cli/tsup.bundle.config.ts >/dev/null

OUT="$REPO_ROOT/bin/agentroom"
# tsup picks .mjs or .js depending on the nearest package.json — accept either.
OUT_JS=""
for cand in "$REPO_ROOT/bin/agentroom.mjs" "$REPO_ROOT/bin/agentroom.js"; do
	[ -f "$cand" ] && {
		OUT_JS="$cand"
		break
	}
done
[ -n "$OUT_JS" ] || {
	echo "bundle not produced in $REPO_ROOT/bin/" >&2
	exit 1
}

# esbuild strips the "node:" prefix from built-in imports (node:sqlite → sqlite).
# Restore it so Node resolves the built-in correctly.
node -e '
const fs=require("fs");const p=process.argv[1];
let s=fs.readFileSync(p,"utf8");
s=s.replace(/from\s*"sqlite"/g,'"'"'from "node:sqlite"'"'"').replace(/require\("sqlite"\)/g,'"'"'require("node:sqlite")'"'"');
fs.writeFileSync(p,s);
' "$OUT_JS"

mv -f "$OUT_JS" "$OUT"
chmod +x "$OUT"
echo "built $OUT ($(wc -c <"$OUT") bytes)"
