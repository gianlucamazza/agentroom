# agentroom developers page — longer, slower walkthrough. Render: `vhs demo/developers.tape`
# Same player, dev pacing (DEMO_VARIANT=dev), taller frame so more of the
# conversation stays on screen. Outputs to docs/ for GitHub Pages.
Output docs/media/agentroom-demo-dev.webm
Output docs/media/agentroom-demo-dev.mp4

Require bash
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 20
Set Width 1200
Set Height 760
Set Padding 40
Set Margin 0
Set WindowBar Colorful
Set BorderRadius 10
Set Theme { "name": "agentroom", "background": "#0c0c0b", "foreground": "#f4f1ea", "cursor": "#b45f43", "selection": "#1f1f1d", "black": "#0c0c0b", "red": "#b45f43", "green": "#7eb078", "yellow": "#c9714f", "blue": "#8f8a82", "magenta": "#c9714f", "cyan": "#a8a29a", "white": "#f4f1ea", "brightBlack": "#78736c", "brightRed": "#c9714f", "brightGreen": "#7eb078", "brightYellow": "#c9714f", "brightBlue": "#a8a29a", "brightMagenta": "#c9714f", "brightCyan": "#f4f1ea", "brightWhite": "#ffffff" }

Hide
Type "DEMO_VARIANT=dev exec bash demo/playback.sh"
Enter
Show
Sleep 32s
