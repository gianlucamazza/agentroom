import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { sodiumReady } from "@agentroom/protocol";
import { AgentroomClient } from "@agentroom/sdk";
import { attachWss, getWss } from "./ws.js";
import { handleRequest } from "./routes.js";

// The reconnect state machine lives in the SDK but needs a real relay to
// exercise: token fast-path, fallback to HELLO, backoff, max-attempts.

let httpServer: Server;
let serverUrl: string;
let tmpDir: string;
let port: number;

function startServer(fixedPort = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer = createServer(handleRequest);
    attachWss(httpServer);
    httpServer.once("error", reject);
    httpServer.listen(fixedPort, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("bad address"));
        return;
      }
      port = addr.port;
      serverUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    // upgraded WS sockets are not tracked by the HTTP server, so
    // closeAllConnections() alone would leave close() hanging forever
    for (const c of getWss()?.clients ?? []) c.terminate();
    httpServer.closeAllConnections?.();
    httpServer.close(() => resolve());
  });
}

function waitFor<T>(
  register: (emit: (v: T) => void) => void,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
    register((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

beforeAll(async () => {
  process.env["HMAC_SECRET"] = "a".repeat(32);
  process.env["AGENTROOM_DB"] = ":memory:";
  process.env["RATE_LIMIT_DISABLED"] = "1";
  await sodiumReady();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentroom-reconnect-"));
  await startServer();
});

afterAll(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SDK reconnect state machine", () => {
  it("reconnects after the server drops the connection (token fast-path)", async () => {
    const client = new AgentroomClient();
    const reconnected = waitFor<void>((emit) =>
      client.onReconnect(() => emit()),
    );
    const disconnected = waitFor<string>((emit) => client.onDisconnect(emit));

    await client.connect({
      serverUrl,
      home: path.join(tmpDir, `alice-${randomUUID()}`),
      autoReconnect: true,
      reconnect: { maxBackoffMs: 50 },
    });

    // server restart drops every socket; client must come back on its own
    await stopServer();
    await startServer(port);

    await Promise.all([disconnected, reconnected]);
    client.disconnect();
  });

  it("falls back to full HELLO when the session token is rejected", async () => {
    const client = new AgentroomClient();
    const reconnected = waitFor<void>((emit) =>
      client.onReconnect(() => emit()),
    );

    await client.connect({
      serverUrl,
      home: path.join(tmpDir, `bob-${randomUUID()}`),
      autoReconnect: true,
      reconnect: { maxBackoffMs: 50 },
    });

    // corrupt the cached token: the resume attempt must fail and the client
    // must recover via the challenge + HELLO path instead of giving up
    (client as unknown as { sessionToken: string }).sessionToken =
      "garbage.token";

    await stopServer();
    await startServer(port);

    await reconnected;
    client.disconnect();
  });

  it("fires onReconnectFailed after maxAttempts and stops retrying", async () => {
    const client = new AgentroomClient();
    const failed = waitFor<string>(
      (emit) => client.onReconnectFailed(emit),
      8000,
    );

    await client.connect({
      serverUrl,
      home: path.join(tmpDir, `carol-${randomUUID()}`),
      autoReconnect: true,
      reconnect: { maxAttempts: 2, maxBackoffMs: 20 },
    });

    // kill the server for good: both attempts must fail
    await stopServer();

    const reason = await failed;
    expect(reason).toMatch(/max reconnect attempts \(2\)/);

    client.disconnect();
    await startServer(port); // restore for subsequent tests / afterAll symmetry
  });

  it("does not reconnect after an explicit disconnect()", async () => {
    const client = new AgentroomClient();
    let reconnects = 0;
    client.onReconnect(() => reconnects++);

    await client.connect({
      serverUrl,
      home: path.join(tmpDir, `dave-${randomUUID()}`),
      autoReconnect: true,
      reconnect: { maxBackoffMs: 20 },
    });

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200)); // give a wrong impl time to retry
    expect(reconnects).toBe(0);
  });
});
