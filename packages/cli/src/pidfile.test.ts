import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writePidfile, readPidfiles, removePidfile, isAlive } from "./pidfile.js";

const homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(path.join(tmpdir(), "agentroom-pid-"));
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("isAlive", () => {
  it("true for our own pid", () => expect(isAlive(process.pid)).toBe(true));
  it("false for an impossible pid", () => expect(isAlive(2_000_000_000)).toBe(false));
  it("false for nonsense", () => { expect(isAlive(0)).toBe(false); expect(isAlive(-1)).toBe(false); });
});

describe("pidfile read/write/remove", () => {
  it("writes and reads back a room entry, annotated alive", () => {
    const home = freshHome();
    writePidfile(8787, { pid: process.pid, kind: "room", tunnel_url: "wss://x/ws", local_url: "ws://localhost:8787/ws", started_at: 1 }, home);
    const rooms = readPidfiles(home);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ port: 8787, pid: process.pid, kind: "room", tunnel_url: "wss://x/ws", alive: true });
  });

  it("removePidfile deletes the entry", () => {
    const home = freshHome();
    writePidfile(9000, { pid: process.pid, kind: "relay", local_url: "ws://localhost:9000/ws", started_at: 1 }, home);
    removePidfile(9000, home);
    expect(readPidfiles(home)).toHaveLength(0);
  });

  it("prune drops dead-pid files but keeps live ones", () => {
    const home = freshHome();
    writePidfile(8787, { pid: process.pid, kind: "room", local_url: "ws://localhost:8787/ws", started_at: 1 }, home);
    writePidfile(8788, { pid: 2_000_000_000, kind: "room", local_url: "ws://localhost:8788/ws", started_at: 1 }, home);
    const rooms = readPidfiles(home, true);
    expect(rooms.map((r) => r.port)).toEqual([8787]);
    // the dead one's file is gone
    expect(readPidfiles(home)).toHaveLength(1);
  });

  it("returns [] when no rooms dir exists", () => {
    expect(readPidfiles(freshHome())).toEqual([]);
  });

  it("sorts by port", () => {
    const home = freshHome();
    writePidfile(9001, { pid: process.pid, kind: "room", local_url: "a", started_at: 1 }, home);
    writePidfile(8787, { pid: process.pid, kind: "room", local_url: "b", started_at: 1 }, home);
    expect(readPidfiles(home).map((r) => r.port)).toEqual([8787, 9001]);
  });
});
