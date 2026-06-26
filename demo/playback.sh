#!/usr/bin/env bash
# Deterministic terminal "player" for the agentroom landing demo.
#
# Renders demo/transcript.json as a branded two-agent conversation, animated
# with absolute cursor positioning (no real network / LLM calls). VHS records
# this script; all timing lives here so the take is reproducible.
#
#   bash demo/playback.sh            # hero pacing (~17s)
#   DEMO_VARIANT=dev bash demo/...   # developers pacing (slower)
#
# Source of truth: demo/transcript.json (real handler output is written there by
# demo/capture.sh). This script only draws — it never reaches the network.
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
GREEN=$'\033[38;2;126;176;120m' # lit-chip success tint
B=$'\033[1m'
R=$'\033[0m'

# --- timing (seconds) -------------------------------------------------------
if [ "$VARIANT" = dev ]; then
	T_HOLD=1.0
	T_CMD=1.2
	T_MSG=2.1
	T_TYPE=0.013
	T_END=2.6
else
	T_HOLD=0.7
	T_CMD=0.95
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
CMD_ROW=6                            # transient command line
CONV_ROW=8                           # first conversation row (reset after seed)

cleanup() {
	printf '%s\033[?25h' "$R"
	tput cnorm 2>/dev/null || true
}
trap cleanup EXIT
printf '\033[?25l' # hide cursor
clear

# --- load transcript (Node >= 22 is a project requirement) ------------------
eval "$(node "$HERE/_load.mjs" "$TRANSCRIPT")"

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
	# Claude label, left, terracotta bar
	at 3 2
	printf '%s▌%s %s%s%s %s· %s%s' "$TERRA" "$R" "$B$TERRA2" "$L_NAME" "$R" "$DIM" "$L_ROLE" "$R"
	# Codex label, right-aligned (compute pad from PLAIN width, then colorize)
	local plain="${R_NAME} · ${R_ROLE} ▐"
	local col=$((RIGHT - ${#plain}))
	at 3 "$col"
	printf '%s%s%s %s· %s%s %s▐%s' "$B$TEXT" "$R_NAME" "$R" "$DIM" "$R_ROLE" "$R" "$TERRA" "$R"
}

# chips row (row 4); $1 = number of chips lit
draw_chips() {
	local lit=$1 i col=2
	at 4 0
	tput el
	for i in "${!CHIPS[@]}"; do
		at 4 "$col"
		if ((i < lit)); then
			printf '%s●%s %s%s%s' "$GREEN" "$R" "$MUTED" "${CHIPS[$i]}" "$R"
		else printf '%s○ %s%s' "$DIM" "${CHIPS[$i]}" "$R"; fi
		col=$((col + ${#CHIPS[$i]} + 4))
	done
}

# conversation viewport ------------------------------------------------------
BLOCKS_SIDE=()
BLOCKS_TEXT=()
repaint_conversation() { # $1 = index of newest block (typewritten) or -1
	local newest=$1 row=$CONV_ROW i side txt ln first
	at "$CONV_ROW" 0
	tput ed
	local maxrows=$((LINES - CONV_ROW - 1)) perblk=3
	local keep=$((maxrows / perblk))
	((keep < 1)) && keep=1
	local start=0
	((${#BLOCKS_SIDE[@]} > keep)) && start=$((${#BLOCKS_SIDE[@]} - keep))
	for ((i = start; i < ${#BLOCKS_SIDE[@]}; i++)); do
		side=${BLOCKS_SIDE[$i]}
		txt=${BLOCKS_TEXT[$i]}
		local -a lines
		mapfile -t lines < <(printf '%s\n' "$txt" | fold -s -w "$CARD_W")
		if [ "$side" = left ]; then
			at "$row" "$LEFT"
			printf '%s▌%s %s%sClaude Code%s' "$TERRA" "$R" "$B" "$TERRA2" "$R"
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
			local lab="Codex ▐"
			at "$row" $((RIGHT - ${#lab}))
			printf '%s%sCodex%s %s▐%s' "$B" "$TEXT" "$R" "$TERRA" "$R"
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
	BLOCKS_SIDE+=("$1")
	BLOCKS_TEXT+=("$2")
	repaint_conversation $((${#BLOCKS_SIDE[@]} - 1))
}

# ============================ timeline ======================================
draw_header
draw_chips 0
nap "$T_HOLD"

# 1) setup commands flash on the command line; each lights a chip
chip=0
for c in "${CMDS[@]}"; do
	at "$CMD_ROW" 2
	tput el
	printf '%s$%s ' "$DIM" "$R"
	typewrite "$CMD_ROW" 4 "$TEXT" "$c"
	chip=$((chip + 1))
	draw_chips "$chip"
	nap "$T_CMD"
done
at "$CMD_ROW" 0
tput el

# 2) human seed / task brief
at "$CMD_ROW" 2
printf '%s›%s ' "$TERRA2" "$R"
mapfile -t seedlines < <(printf '%s\n' "$SEED" | fold -s -w $((RIGHT - 8)))
sr=$CMD_ROW
first=1
for ln in "${seedlines[@]}"; do
	if ((first)); then
		typewrite "$sr" 4 "$TEXT" "$ln"
	else
		at "$sr" 4
		printf '%s%s%s' "$DIM" "$ln" "$R"
	fi
	first=0
	sr=$((sr + 1))
done
CONV_ROW=$((sr + 1))
nap "$T_MSG"

# 3) conversation
for i in "${!MSG_SIDE[@]}"; do
	add_message "${MSG_SIDE[$i]}" "${MSG_TEXT[$i]}"
	nap "$T_MSG"
done

# 4) final chip + hold on last frame (park cursor offscreen so no caret block)
draw_chips "${#CHIPS[@]}"
at $((LINES - 1)) 0
nap "$T_END"
