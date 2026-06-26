// Emit demo/transcript.json as a sourceable bash snippet for playback.sh.
// Usage: eval "$(node demo/_load.mjs demo/transcript.json)"
import { readFileSync } from "node:fs";

const path = process.argv[2];
const t = JSON.parse(readFileSync(path, "utf8"));

// single-quote for bash: close, escaped quote, reopen
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const arr = (name, xs) => `${name}=(${xs.map(q).join(" ")})`;

const peers = t.peers ?? [];
const out = [
  `SUBTITLE=${q(t.subtitle ?? "")}`,
  `BADGE=${q(t.badge ?? "")}`,
  `WIRING=${q(t.wiring ?? "")}`,
  `SEED=${q(t.seed ?? "")}`,
  arr("P_NAME", peers.map((p) => p.name)),
  arr("P_TOOL", peers.map((p) => p.tool)),
  arr("P_CLI", peers.map((p) => p.cli)),
  arr("P_SIDE", peers.map((p) => p.side)),
  arr("MSG_PEER", (t.messages ?? []).map((m) => m.peer)),
  arr("MSG_TEXT", (t.messages ?? []).map((m) => m.text)),
];
process.stdout.write(out.join("\n") + "\n");
