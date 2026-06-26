#!/usr/bin/env bash
# Deterministic terminal "player" for the agentroom landing demo.
#
# Story: colleagues on one project, each driving a different coding tool through
# its own CLI (Claude Code / Codex / OpenCode). Their agents talk directly over
# agentroom — encrypted, peer-to-peer. This script renders demo/transcript.json
# with absolute cursor positioning; all timing lives here (reproducible take),
# and it never touches the network.
#
#   bash demo/playback.sh            # hero pacing
#   DEMO_VARIANT=dev bash demo/...   # developers pacing (slower)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSCRIPT="${DEMO_TRANSCRIPT:-$HERE/transcript.json}"
VARIANT="${DEMO_VARIANT:-hero}"

# --- brand palette (24-bit truecolor, matches docs/style.css) ---------------
TERRA=$'\033[38;2;180;95;67m'   # --accent  #b45f43
TERRA2=$'\033[38;2;201;113;79m' # --accent-strong #c9714f
TEXT=$'\033[38;2;244;241;234m'  # --text    #f4f1ea
MUTED=$'\033[38;2;168;162;154m' # --muted   #a8a29a
DIM=$'\033[38;2;120;115;108m'   # subtle
GREEN=$'\033[38;2;126;176;120m' # success / encrypted tint
B=$'\033[1m'
R=$'\033[0m'

# --- timing (seconds) -------------------------------------------------------
if [ "$VARIANT" = dev ]; then
	T_HOLD=1.0
	T_MSG=2.1
	T_TYPE=0.013
	T_END=2.6
else
	T_HOLD=0.7
	T_MSG=1.7
	T_TYPE=0.010
	T_END=2.2
fi
nap() { sleep "$1" 2>/dev/null || true; }

# --- layout -----------------------------------------------------------------
COLS=$(tput cols 2>/dev/null || echo 84)
LINES=$(tput lines 2>/dev/null || echo 24)
LEFT=4                               # left card indent
RIGHT=$((COLS > 84 ? 80 : COLS - 4)) # right card edge column
CARD_W=36                            # wrapped text width inside a card
CONV_ROW=10                          # first conversation row

cleanup() {
	printf '%s\033[?25h' "$R"
	tput cnorm 2>/dev/null || true
}
trap cleanup EXIT
printf '\033[?25l' # hide cursor
clear

# --- load transcript (Node >= 22 is a project requirement) ------------------
eval "$(node "$HERE/_load.mjs" "$TRANSCRIPT")"

# peer name -> tool / side lookups; first left-side peer = the "you" speaker
declare -A TOOL_OF SIDE_OF
LEFT_PEER=""
for i in "${!P_NAME[@]}"; do
	TOOL_OF[${P_NAME[$i]}]=${P_TOOL[$i]}
	SIDE_OF[${P_NAME[$i]}]=${P_SIDE[$i]}
	[ "${P_SIDE[$i]}" = left ] && [ -z "$LEFT_PEER" ] && LEFT_PEER=${P_NAME[$i]}
done
DOTC=("$TERRA2" "$TEXT" "$GREEN") # per-peer dot tint, within brand

at() { tput cup "$1" "$2"; }

# typewriter: reveal plain $4 char-by-char at row $1 col $2 in color $3
typewrite() {
	local row=$1 col=$2 color=$3 txt=$4 i
	at "$row" "$col"
	printf '%s' "$color"
	for ((i = 0; i < ${#txt}; i++)); do
		printf '%s' "${txt:i:1}"
		nap "$T_TYPE"
	done
	printf '%s' "$R"
}

draw_header() {
	at 1 2
	printf '%s%sagentroom%s  %s· %s%s' "$B" "$TEXT" "$R" "$DIM" "$SUBTITLE" "$R"
	at 2 2
	printf '%s' "$DIM"
	printf '─%.0s' $(seq 1 $((RIGHT - 2)))
	printf '%s' "$R"
}

# roster of coding tools, each with its real CLI (the engine doing the work)
draw_roster() {
	local i row=3 clicol=30
	for i in "${!P_NAME[@]}"; do
		at "$row" 2
		printf '%s●%s %s%s%s %s· %s%s' "${DOTC[$i]:-$TERRA2}" "$R" "$B$TEXT" "${P_NAME[$i]}" "$R" "$DIM" "${P_TOOL[$i]}" "$R"
		at "$row" "$clicol"
		printf '%s→ %s%s%s' "$DIM" "$MUTED" "${P_CLI[$i]}" "$R"
		row=$((row + 1))
	done
}

draw_badge() {
	at 6 2
	printf '%s%s %s%s%s' "$GREEN" "" "$MUTED" "$BADGE" "$R"
}

# one dim line: this is how the skill plugs a coding-agent CLI in
draw_wiring() {
	local cmd="${WIRING%%#*}" cm="#${WIRING#*#}"
	at 7 2
	printf '%s%s%s%s%s%s' "$MUTED" "$cmd" "$R" "$DIM" "$cm" "$R"
}

# conversation viewport ------------------------------------------------------
BLOCKS_PEER=()
BLOCKS_TEXT=()
repaint_conversation() { # $1 = index of newest block (typewritten) or -1
	local newest=$1 row=$CONV_ROW i peer side tool txt ln first label
	at "$CONV_ROW" 0
	tput ed
	local maxrows=$((LINES - CONV_ROW - 1)) perblk=3
	local keep=$((maxrows / perblk))
	((keep < 1)) && keep=1
	local start=0
	((${#BLOCKS_PEER[@]} > keep)) && start=$((${#BLOCKS_PEER[@]} - keep))
	for ((i = start; i < ${#BLOCKS_PEER[@]}; i++)); do
		peer=${BLOCKS_PEER[$i]}
		txt=${BLOCKS_TEXT[$i]}
		side=${SIDE_OF[$peer]:-left}
		tool=${TOOL_OF[$peer]:-}
		label="$peer · $tool"
		local -a lines
		mapfile -t lines < <(printf '%s\n' "$txt" | fold -s -w "$CARD_W")
		if [ "$side" = left ]; then
			at "$row" "$LEFT"
			printf '%s▌%s %s%s%s%s' "$TERRA" "$R" "$B" "$TERRA2" "$label" "$R"
			row=$((row + 1))
			first=1
			for ln in "${lines[@]}"; do
				if ((i == newest && first)); then
					typewrite "$row" $((LEFT + 2)) "$TEXT" "$ln"
				else
					at "$row" $((LEFT + 2))
					printf '%s%s%s' "$TEXT" "$ln" "$R"
				fi
				first=0
				row=$((row + 1))
			done
		else
			local lab="$label ▐"
			at "$row" $((RIGHT - ${#lab}))
			printf '%s%s%s%s %s▐%s' "$B" "$TEXT" "$label" "$R" "$TERRA" "$R"
			row=$((row + 1))
			first=1
			for ln in "${lines[@]}"; do
				local col=$((RIGHT - ${#ln}))
				if ((i == newest && first)); then
					typewrite "$row" "$col" "$MUTED" "$ln"
				else
					at "$row" "$col"
					printf '%s%s%s' "$MUTED" "$ln" "$R"
				fi
				first=0
				row=$((row + 1))
			done
		fi
		row=$((row + 1))
	done
}
add_message() {
	BLOCKS_PEER+=("$1")
	BLOCKS_TEXT+=("$2")
	repaint_conversation $((${#BLOCKS_PEER[@]} - 1))
}

# ============================ timeline ======================================
draw_header
nap "$T_HOLD"
draw_roster
nap "$T_HOLD"
draw_badge
draw_wiring
nap "$T_HOLD"

# conversation: Alice's opening (fixed seed) + the captured replies
ALL_PEER=("$LEFT_PEER" "${MSG_PEER[@]}")
ALL_TEXT=("$SEED" "${MSG_TEXT[@]}")
for i in "${!ALL_PEER[@]}"; do
	add_message "${ALL_PEER[$i]}" "${ALL_TEXT[$i]}"
	nap "$T_MSG"
done

# hold on the last frame (park cursor offscreen so no caret block)
at $((LINES - 1)) 0
nap "$T_END"
