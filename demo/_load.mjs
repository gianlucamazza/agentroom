// Emit demo/transcript.json as a sourceable bash snippet for playback.sh.
// Usage: eval "$(node demo/_load.mjs demo/transcript.json)"
import { readFileSync } from "node:fs";

const path = process.argv[2];
const t = JSON.parse(readFileSync(path, "utf8"));

// single-quote for bash: close, escaped quote, reopen
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const arr = (name, xs) => `${name}=(${xs.map(q).join(" ")})`;

const out = [
  `SUBTITLE=${q(t.subtitle ?? "")}`,
  `L_NAME=${q(t.left?.name ?? "Claude Code")}`,
  `L_ROLE=${q(t.left?.role ?? "")}`,
  `R_NAME=${q(t.right?.name ?? "Codex")}`,
  `R_ROLE=${q(t.right?.role ?? "")}`,
  `SEED=${q(t.seed ?? "")}`,
  arr("CMDS", t.commands ?? []),
  arr("CHIPS", t.chips ?? []),
  arr("MSG_SIDE", (t.messages ?? []).map((m) => m.side)),
  arr("MSG_TEXT", (t.messages ?? []).map((m) => m.text)),
];
process.stdout.write(out.join("\n") + "\n");
