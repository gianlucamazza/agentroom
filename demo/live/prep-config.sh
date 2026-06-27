#!/usr/bin/env bash
# Build an isolated, clean Claude Code config for the recorded demo session:
# real OAuth (copied), onboarding pre-completed (seeded from your real config,
# minus personal data), dark theme, no hooks / no output-style, and a permission
# allow-list so the agentroom commands run without prompts or scary banners.
#
# Prints the config dir path on stdout. State lives under $STATE_DIR (in /tmp).
set -euo pipefail
STATE_DIR="${AGENTROOM_DEMO_STATE:-/tmp/agentroom-live-demo}"
CFG="$STATE_DIR/claude-cfg"
WORK="$STATE_DIR/work"
mkdir -p "$CFG" "$WORK"

cp "$HOME/.claude/.credentials.json" "$CFG/.credentials.json"

cat >"$CFG/settings.json" <<'JSON'
{
  "theme": "dark",
  "includeCoAuthoredBy": false,
  "permissions": {
    "allow": ["Bash(agentroom:*)", "Bash(bash:*)", "Bash(timeout:*)", "Bash(echo:*)"]
  }
}
JSON

# Empty MCP config so the recorded session can run with --strict-mcp-config and
# show NO "MCP server needs authentication" banner (your real ~/.claude settings
# define MCP servers; --strict-mcp-config ignores them).
printf '{"mcpServers":{}}' >"$CFG/empty-mcp.json"

# Seed onboarding/"seen" flags from the real config so no first-run dialogs fire,
# but strip everything personal (projects, mcp servers, history, tips).
CFG="$CFG" WORK="$WORK" node -e '
const fs=require("fs"),os=require("os");
const real=JSON.parse(fs.readFileSync(os.homedir()+"/.claude.json","utf8"));
const drop=new Set(["projects","mcpServers","mcpContextUris","enabledMcpjsonServers",
  "disabledMcpjsonServers","tipsHistory","seenNotifications","history","oauthAccount"]);
const c={};
for(const k of Object.keys(real)) if(!drop.has(k)) c[k]=real[k];
c.hasCompletedOnboarding=true; c.theme="dark";
delete c.cachedChromeExtensionInstalled;
c.projects={};
c.projects[process.env.WORK]={allowedTools:[],hasTrustDialogAccepted:true,
  hasCompletedProjectOnboarding:true,projectOnboardingSeenCount:3};
// keep oauthAccount from the real config so the account is recognized (no re-auth)
c.oauthAccount=real.oauthAccount;
fs.writeFileSync(process.env.CFG+"/.claude.json",JSON.stringify(c,null,2));
'
echo "$CFG"
