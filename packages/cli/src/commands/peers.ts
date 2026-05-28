import { sessionsDir } from "@agentroom/sdk";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdPeers(args: string[]) {
  const home = getArg(args, "--home");
  const dir = sessionsDir(home);

  if (!existsSync(dir)) {
    console.log("No sessions found. Complete an invite handshake first.");
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No sessions found. Complete an invite handshake first.");
    return;
  }

  const jsonMode = args.includes("--json");
  const rows: Array<{ pk: string; lastUsedAt: number; sendSeq: number; recvSeq: number }> = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
        peerPk?: string;
        lastUsedAt?: number;
        sendSeq?: number;
        recvSeq?: number;
      };
      rows.push({
        pk: raw.peerPk ?? file.replace(".json", ""),
        lastUsedAt: raw.lastUsedAt ?? 0,
        sendSeq: raw.sendSeq ?? 0,
        recvSeq: raw.recvSeq ?? -1,
      });
    } catch {
      // corrupt file — skip
    }
  }

  rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  for (const r of rows) {
    const age = r.lastUsedAt
      ? new Date(r.lastUsedAt).toLocaleString()
      : "unknown";
    console.log(`${r.pk}`);
    console.log(`  last used: ${age}  sent: ${r.sendSeq}  received: ${r.recvSeq + 1}`);
  }
}
