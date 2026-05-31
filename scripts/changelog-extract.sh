#!/usr/bin/env bash
# Print the CHANGELOG.md section for a given version, for use as GitHub Release notes.
# Usage: scripts/changelog-extract.sh <version|vX.Y.Z>   (v-prefix optional)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ver="${1:?usage: changelog-extract.sh <version>}"
ver="${ver#v}" # strip leading v

awk -v ver="$ver" '
  $0 ~ "^## v" ver "( |$|\\()" { grab=1; next }   # start at "## v<ver>" header (skip the header line)
  grab && /^## v/ { exit }                          # stop at the next version header
  grab { print }
' "$REPO_ROOT/CHANGELOG.md" | sed -e :a -e '/^\n*$/{$d;N;ba}' # trim leading/trailing blank lines
