# agentroom landing — hero loop (silent autoplay). Render: `vhs demo/hero.tape`
# Deterministic: all animation lives in demo/playback.sh, sourced from
# demo/transcript.json. Outputs go to docs/ so GitHub Pages publishes them.
Output docs/media/agentroom-demo.webm
Output docs/media/agentroom-demo.mp4

Require bash
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 22
Set Width 1440
Set Height 600
Set Padding 40
Set Margin 0
Set WindowBar Colorful
Set BorderRadius 10
Set Theme { "name": "agentroom", "background": "#0c0c0b", "foreground": "#f4f1ea", "cursor": "#b45f43", "selection": "#1f1f1d", "black": "#0c0c0b", "red": "#b45f43", "green": "#7eb078", "yellow": "#c9714f", "blue": "#8f8a82", "magenta": "#c9714f", "cyan": "#a8a29a", "white": "#f4f1ea", "brightBlack": "#78736c", "brightRed": "#c9714f", "brightGreen": "#7eb078", "brightYellow": "#c9714f", "brightBlue": "#a8a29a", "brightMagenta": "#c9714f", "brightCyan": "#f4f1ea", "brightWhite": "#ffffff" }

# exec replaces the shell with the player, so no prompt returns when it ends —
# VHS trims the trailing idle to the completed board (clean loop point).
Hide
Type "exec bash demo/playback.sh"
Enter
Show
Sleep 24s
