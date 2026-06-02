import { describe, it, expect } from "vitest";
import { runHandler } from "./handler.js";

const env = { from: "PEERPK", pk: "MYPK" };

describe("runHandler", () => {
  it("returns trimmed stdout as the reply on success", async () => {
    const r = await runHandler("cat", "hello world", env, 5000);
    expect(r.code).toBe(0);
    expect(r.reply).toBe("hello world");
  });

  it("sends nothing (empty reply) on a non-zero exit", async () => {
    const r = await runHandler("sh -c 'echo nope; exit 3'", "x", env, 5000);
    expect(r.code).toBe(3);
    expect(r.reply).toBe(""); // stdout discarded when exit != 0
  });

  it("returns empty reply when the handler prints nothing", async () => {
    const r = await runHandler("true", "x", env, 5000);
    expect(r.code).toBe(0);
    expect(r.reply).toBe("");
  });

  it("exposes the message on stdin and peer pk via AGENTROOM_FROM", async () => {
    const r = await runHandler('sh -c \'read m; echo "$AGENTROOM_FROM:$m"\'', "ping", env, 5000);
    expect(r.code).toBe(0);
    expect(r.reply).toBe("PEERPK:ping");
  });

  it("kills a handler that never exits and reports a timeout (code -1)", async () => {
    const start = Date.now();
    const r = await runHandler("sleep 30", "x", env, 300);
    const elapsed = Date.now() - start;
    expect(r.code).toBe(-1);
    expect(r.reply).toBe("");
    expect(r.stderr).toMatch(/timed out/i);
    expect(elapsed).toBeLessThan(3000); // didn't wait out the full sleep
  });

  it("reports an error (code -1) when the command can't be spawned", async () => {
    const r = await runHandler("this-command-does-not-exist-xyz", "x", env, 5000);
    expect(r.code).not.toBe(0); // shell exits 127, or spawn error → -1
    expect(r.reply).toBe("");
  });

  it("does not throw when the handler ignores stdin and exits early (EPIPE)", async () => {
    // A large payload to a handler that never reads stdin reliably triggers an
    // EPIPE on the stdin write; it must be swallowed, not crash the process.
    const big = "x".repeat(1024 * 1024);
    const r = await runHandler("true", big, env, 5000);
    expect(r.code).toBe(0);
    expect(r.reply).toBe("");
  });
});
