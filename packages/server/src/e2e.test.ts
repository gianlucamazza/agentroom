import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { sodiumReady } from "@agentroom/protocol";
import { AgentroomClient } from "@agentroom/sdk";
import { attachWss } from "./ws.js";
import { handleRequest } from "./routes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let httpServer: Server;
let serverUrl: string;
let tmpDir: string;

function makeTmpHome(name: string) {
  return path.join(tmpDir, name);
}

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    httpServer = createServer(handleRequest);
    attachWss(httpServer);
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
      resolve(`ws://127.0.0.1:${addr.port}/ws`);
    });
  });
}

/** Wait for an event to occur within a timeout. Rejects on timeout. */
function waitFor<T>(
  register: (emit: (v: T) => void) => void,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
    register((v) => { clearTimeout(t); resolve(v); });
  });
}

/** Create a pair of connected agents that have completed the handshake. */
async function handshakePair(suffix = "") {
  const aliceHome = makeTmpHome(`alice-${suffix}-${randomUUID()}`);
  const bobHome   = makeTmpHome(`bob-${suffix}-${randomUUID()}`);

  const alice = new AgentroomClient();
  const bob   = new AgentroomClient();

  await alice.connect({ serverUrl, home: aliceHome });
  await bob.connect({ serverUrl, home: bobHome });

  // Alice creates invite and waits for Bob to come online
  const aliceSeenBob   = waitFor<string>((emit) => alice.onPeerOnline(emit));
  const bobSeenAlice   = waitFor<string>((emit) => bob.onPeerOnline(emit));

  const { url } = await alice.createInvite();
  const alicePk = await bob.acceptInvite(url);

  // Wait for both sides to confirm the handshake
  await Promise.all([aliceSeenBob, bobSeenAlice]);

  const bobPk = bob.publicKey();
  return { alice, bob, alicePk, bobPk };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env["HMAC_SECRET"] = "a".repeat(32);
  process.env["AGENTROOM_DB"] = ":memory:";
  process.removeAllListeners("warning");

  await sodiumReady();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentroom-e2e-"));
  serverUrl = await startServer();
});

afterAll(() => {
  httpServer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("E2E: invite → connect → send → receive", () => {
  it("bob sends message, alice receives", async () => {
    const { alice, bob, alicePk, bobPk } = await handshakePair("t1");

    const aliceGot = waitFor<string>((emit) => alice.onMessage((_, t) => emit(t)));

    await bob.sendMessage(alicePk, "hello from bob");
    expect(await aliceGot).toBe("hello from bob");

    alice.disconnect();
    bob.disconnect();
    void bobPk;
  });

  it("bidirectional: ping-pong", async () => {
    const { alice, bob, alicePk, bobPk } = await handshakePair("t2");

    const aliceGot = waitFor<string>((emit) => alice.onMessage((_, t) => emit(t)));
    const bobGot   = waitFor<string>((emit) => bob.onMessage((_, t)   => emit(t)));

    await bob.sendMessage(alicePk, "ping");
    expect(await aliceGot).toBe("ping");

    await alice.sendMessage(bobPk, "pong");
    expect(await bobGot).toBe("pong");

    alice.disconnect();
    bob.disconnect();
  });

  it("multiple messages in sequence", async () => {
    const { alice, bob, alicePk, bobPk } = await handshakePair("t3");

    const msgs: string[] = [];
    let pendingResolve: ((v: string) => void) | null = null;
    alice.onMessage((_, t) => {
      msgs.push(t);
      if (pendingResolve) { pendingResolve(t); pendingResolve = null; }
    });

    for (let i = 0; i < 5; i++) {
      const p = new Promise<string>((r) => { pendingResolve = r; });
      await bob.sendMessage(alicePk, `msg${i}`);
      expect(await p).toBe(`msg${i}`);
    }
    expect(msgs).toHaveLength(5);

    alice.disconnect();
    bob.disconnect();
    void bobPk;
  });

  it("store-and-forward: message queued while bob offline, delivered on reconnect", async () => {
    const bobSharedHome = makeTmpHome(`bob-shared-${randomUUID()}`);
    const aliceHome = makeTmpHome(`alice-s-${randomUUID()}`);

    const alice = new AgentroomClient();
    const bob   = new AgentroomClient();

    await alice.connect({ serverUrl, home: aliceHome });
    await bob.connect({ serverUrl, home: bobSharedHome });

    const aliceSeenBob = waitFor<string>((emit) => alice.onPeerOnline(emit));
    const bobSeenAlice = waitFor<string>((emit) => bob.onPeerOnline(emit));

    const { url } = await alice.createInvite();
    await bob.acceptInvite(url);
    await Promise.all([aliceSeenBob, bobSeenAlice]);

    const bobPk = bob.publicKey();

    // Bob disconnects
    bob.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Alice sends while Bob is offline → server queues it
    await alice.sendMessage(bobPk, "queued message");

    // Bob reconnects with same identity (same bobSharedHome)
    const bob2 = new AgentroomClient();
    const delivered = waitFor<string>((emit) => bob2.onMessage((_, t) => emit(t)));
    await bob2.connect({ serverUrl, home: bobSharedHome });

    expect(await delivered).toBe("queued message");

    alice.disconnect();
    bob2.disconnect();
  });
});
