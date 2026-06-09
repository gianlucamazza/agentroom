import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { createServer, type Server } from "http";
import {
  generateKeypair,
  sign,
  toBase64,
  sodiumReady,
  PROTOCOL_VERSION,
  type AgentKeypair,
} from "@agentroom/protocol";
import { store } from "./store.js";
import { attachWss } from "./ws.js";
import { handleRequest } from "./routes.js";

let srv: Server;
let url: string;
let httpBase: string;

beforeAll(async () => {
  process.env["HMAC_SECRET"] = "a".repeat(32);
  process.env["AGENTROOM_DB"] = ":memory:";
  process.env["RATE_LIMIT_DISABLED"] = "1";
  process.env["WS_MAX_PAYLOAD"] = String(64 * 1024); // small cap to keep the oversize test cheap
  await sodiumReady();

  srv = createServer(handleRequest);
  attachWss(srv);
  url = await new Promise<string>((res, rej) => {
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        rej(new Error("bad addr"));
        return;
      }
      res(`ws://127.0.0.1:${addr.port}/ws`);
    });
  });
  httpBase = url.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
});

afterAll(() => {
  srv?.close();
});

/** Open a WS and authenticate with a fresh keypair via challenge + HELLO. */
async function authedWs(kp: AgentKeypair): Promise<WebSocket> {
  const chResp = await fetch(`${httpBase}/auth/challenge`);
  const { challenge } = (await chResp.json()) as { challenge: string };
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", async () => {
      const sig = toBase64(
        await sign(new TextEncoder().encode(challenge), kp.ed25519_sk),
      );
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "HELLO",
          msg_id: randomUUID(),
          ts: Date.now(),
          ed25519_pk: toBase64(kp.ed25519_pk),
          x25519_pk: toBase64(kp.x25519_pk),
          sig,
          challenge,
        }),
      );
    });
    ws.once("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string };
      if (f.type === "HELLO_ACK") resolve(ws);
      else reject(new Error(JSON.stringify(f)));
    });
    ws.once("error", reject);
  });
}

/** Send a frame and resolve with the next message received. */
function roundTrip(
  ws: WebSocket,
  frame: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("roundTrip timeout")), 2000);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.send(JSON.stringify(frame));
  });
}

function invitePublishFrame(expires_at: number) {
  return {
    v: PROTOCOL_VERSION,
    type: "INVITE_PUBLISH",
    msg_id: randomUUID(),
    ts: Date.now(),
    invite_id: randomUUID(),
    blob: "x".repeat(64),
    expires_at,
  };
}

describe("WS payload limit", () => {
  it("closes the connection with 1009 on an oversized frame", async () => {
    const kp = await generateKeypair();
    const ws = await authedWs(kp);
    const closed = new Promise<number>((res) =>
      ws.once("close", (code) => res(code)),
    );
    ws.send("x".repeat(80 * 1024)); // exceeds WS_MAX_PAYLOAD=64 KiB
    expect(await closed).toBe(1009);
  });
});

describe("invite quotas", () => {
  it("rejects invite publish beyond MAX_INVITES_PER_PK", async () => {
    process.env["MAX_INVITES_PER_PK"] = "3";
    try {
      const kp = await generateKeypair();
      const ws = await authedWs(kp);
      const expiry = Date.now() + 3_600_000;
      for (let i = 0; i < 3; i++) {
        const ack = await roundTrip(ws, invitePublishFrame(expiry));
        expect(ack["type"]).toBe("ACK");
      }
      const refused = await roundTrip(ws, invitePublishFrame(expiry));
      expect(refused["type"]).toBe("ERROR");
      expect(refused["code"]).toBe("INVITE_QUOTA");
      ws.close();
    } finally {
      delete process.env["MAX_INVITES_PER_PK"];
    }
  });

  it("clamps client-controlled expires_at to 7 days", async () => {
    const kp = await generateKeypair();
    const ws = await authedWs(kp);
    const frame = invitePublishFrame(Date.now() + 365 * 24 * 3_600_000); // 1 year
    const ack = await roundTrip(ws, frame);
    expect(ack["type"]).toBe("ACK");
    const row = store.getInvite(frame.invite_id);
    expect(row).toBeDefined();
    expect(row!.expires_at).toBeLessThanOrEqual(
      Date.now() + 7 * 24 * 3_600_000,
    );
    ws.close();
  });

  it("claim of an expired invite returns EXPIRED", async () => {
    const inviter = await generateKeypair();
    const claimer = await generateKeypair();
    const inviteId = randomUUID();
    store.publishInvite(
      inviteId,
      "blob",
      toBase64(inviter.ed25519_pk),
      Date.now() - 1,
    );

    const ws = await authedWs(claimer);
    const nonce = toBase64(new TextEncoder().encode("nonce"));
    const sigPayload = new TextEncoder().encode(
      JSON.stringify({
        from: toBase64(claimer.ed25519_pk),
        to: toBase64(inviter.ed25519_pk),
        seq: 0,
        nonce,
      }),
    );
    const resp = await roundTrip(ws, {
      v: PROTOCOL_VERSION,
      type: "INVITE_CLAIM",
      msg_id: randomUUID(),
      ts: Date.now(),
      invite_id: inviteId,
      from: toBase64(claimer.ed25519_pk),
      ciphertext: toBase64(new TextEncoder().encode("payload")),
      nonce,
      sig: toBase64(await sign(sigPayload, claimer.ed25519_sk)),
    });
    expect(resp["type"]).toBe("ERROR");
    expect(resp["code"]).toBe("EXPIRED");
    ws.close();
  });
});

describe("connection cap", () => {
  it("refuses upgrades beyond MAX_CONNECTIONS", async () => {
    // dedicated server: the shared one may still hold draining sockets from
    // previous tests, which would count against the cap
    process.env["MAX_CONNECTIONS"] = "1";
    const srv2 = createServer(handleRequest);
    attachWss(srv2);
    try {
      const url2 = await new Promise<string>((res, rej) => {
        srv2.once("error", rej);
        srv2.listen(0, "127.0.0.1", () => {
          const addr = srv2.address();
          if (!addr || typeof addr === "string") {
            rej(new Error("bad addr"));
            return;
          }
          res(`ws://127.0.0.1:${addr.port}/ws`);
        });
      });
      const ws1 = new WebSocket(url2);
      await new Promise((res, rej) => {
        ws1.once("open", res);
        ws1.once("error", rej);
      });
      const ws2 = new WebSocket(url2);
      const failed = await new Promise<boolean>((res) => {
        ws2.once("open", () => res(false));
        ws2.once("error", () => res(true));
      });
      expect(failed).toBe(true);
      ws1.close();
    } finally {
      delete process.env["MAX_CONNECTIONS"];
      srv2.close();
    }
  });
});
