import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { configBase } from "@agentroom/sdk";

export interface RoomMeta {
  pid: number;
  kind: "room" | "relay";
  tunnel_url?: string;
  local_url: string;
  started_at: number;
}

export interface RoomEntry extends RoomMeta {
  port: number;
  alive: boolean;
}

function roomsDir(home?: string): string {
  return path.join(configBase(home), "rooms");
}

function pidfilePath(port: number, home?: string): string {
  return path.join(roomsDir(home), `${port}.json`);
}

/** True if a process with this pid exists (signal 0 probes without killing). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = alive but not ours (still "alive").
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writePidfile(port: number, meta: RoomMeta, home?: string): void {
  const dir = roomsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = pidfilePath(port, home);
  writeFileSync(file, JSON.stringify(meta), { encoding: "utf8" });
  chmodSync(file, 0o600);
}

export function removePidfile(port: number, home?: string): void {
  try { unlinkSync(pidfilePath(port, home)); } catch { /* already gone */ }
}

/**
 * Read all room pidfiles, annotating each with whether its process is alive.
 * With `prune`, files whose process is dead are deleted (self-healing on stale
 * entries left by a crash that skipped the shutdown handler).
 */
export function readPidfiles(home?: string, prune = false): RoomEntry[] {
  const dir = roomsDir(home);
  if (!existsSync(dir)) return [];
  const out: RoomEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const port = parseInt(file.slice(0, -5), 10);
    if (!Number.isInteger(port)) continue;
    let meta: RoomMeta;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as RoomMeta;
    } catch {
      continue; // corrupt — ignore
    }
    const alive = isAlive(meta.pid);
    if (!alive && prune) { removePidfile(port, home); continue; }
    out.push({ ...meta, port, alive });
  }
  return out.sort((a, b) => a.port - b.port);
}
