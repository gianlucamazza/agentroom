import { spawn } from "child_process";

export interface HandlerResult {
  reply: string;
  code: number;
  stderr: string;
}

/**
 * Run the user-supplied handler command for one incoming message.
 * The message text is piped to the handler's stdin; its stdout (trimmed) is the
 * reply. AGENTROOM_FROM (sender pk) and AGENTROOM_PK (our pk) are exported to it.
 * Returns the reply text, or "" to send nothing (empty stdout, or non-zero exit).
 *
 * A handler that never exits (e.g. a misbehaving `claude -p`, a process that
 * blocks on stdin/network) would otherwise stall the serialized message chain
 * forever, leaving the bot silently dead. `timeoutMs` bounds each run: on expiry
 * the child is SIGTERM'd, then SIGKILL'd after a short grace, and we resolve with
 * code -1 so the caller emits handler_error and the chain keeps moving.
 */
export function runHandler(
  cmd: string,
  text: string,
  env: { from: string; pk: string },
  timeoutMs: number,
): Promise<HandlerResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      env: { ...process.env, AGENTROOM_FROM: env.from, AGENTROOM_PK: env.pk },
    });
    let out = "";
    let err = "";
    let settled = false;
    const done = (r: HandlerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(r);
    };

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      err += `\n[agentroom] handler timed out after ${Math.round(timeoutMs / 1000)}s — killed`;
      child.kill("SIGTERM");
      // Escalate if the handler ignores SIGTERM.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref?.();
      done({ reply: "", code: -1, stderr: err.trim() });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => done({ reply: "", code: -1, stderr: String(e) }));
    child.on("close", (code) =>
      done({ reply: (code ?? 0) === 0 ? out.trim() : "", code: code ?? 0, stderr: err }),
    );
    // A handler that ignores its input (e.g. `true`, or one that exits before
    // reading) closes stdin early, so writing the message races its exit and
    // emits EPIPE. That's a benign outcome — the child's close/stdout still
    // decide the reply — but an unhandled stream 'error' would crash `serve`.
    child.stdin.on("error", () => { /* handler closed stdin — ignore */ });
    child.stdin.write(text);
    child.stdin.end();
  });
}
