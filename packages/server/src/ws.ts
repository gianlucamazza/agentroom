import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { IncomingMessage } from "http";
import { randomUUID } from "crypto";
import {
  parseFrame,
  verify,
  fromBase64,
  PROTOCOL_VERSION,
  type HelloFrame,
  type InvitePublishFrame,
  type InviteClaimFrame,
  type RoutedFrame,
} from "@agentroom/protocol";
import { store } from "./store.js";
import { consumeChallenge, issueSessionToken, verifySessionToken } from "./auth.js";

interface ConnectedAgent {
  ws: WebSocket;
  pk: string;
}

const agents = new Map<string, ConnectedAgent>();

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function errorFrame(code: string, message: string) {
  return { v: PROTOCOL_VERSION, type: "ERROR", msg_id: randomUUID(), ts: Date.now(), code, message };
}

function ackFrame(ref_msg_id: string, status: "delivered" | "queued" | "error", error?: string) {
  return { v: PROTOCOL_VERSION, type: "ACK", msg_id: randomUUID(), ts: Date.now(), ref_msg_id, status, ...(error !== undefined ? { error } : {}) };
}

function flushPending(ws: WebSocket, pk: string) {
  const pending = store.dequeuePending(pk);
  for (const { id, envelope } of pending) {
    try {
      const routed = JSON.parse(envelope) as RoutedFrame;
      send(ws, { v: PROTOCOL_VERSION, type: "DELIVERY", msg_id: randomUUID(), ts: Date.now(), routed });
      store.deletePending(id);
    } catch {
      store.deletePending(id);
    }
  }
}

async function handleHello(ws: WebSocket, frame: HelloFrame) {
  if (!consumeChallenge(frame.challenge)) {
    send(ws, errorFrame("INVALID_CHALLENGE", "challenge expired or unknown"));
    ws.close();
    return;
  }

  const msgBytes = new TextEncoder().encode(frame.challenge);
  const valid = await verify(msgBytes, fromBase64(frame.sig), fromBase64(frame.ed25519_pk));
  if (!valid) {
    send(ws, errorFrame("INVALID_SIG", "signature verification failed"));
    ws.close();
    return;
  }

  store.upsertAgent(frame.ed25519_pk, frame.x25519_pk);
  const session_token = issueSessionToken(frame.ed25519_pk);

  send(ws, { v: PROTOCOL_VERSION, type: "HELLO_ACK", msg_id: randomUUID(), ts: Date.now(), session_token });

  setPk(ws, frame.ed25519_pk);
  agents.set(frame.ed25519_pk, { ws, pk: frame.ed25519_pk });
  flushPending(ws, frame.ed25519_pk);
}

function handleInvitePublish(ws: WebSocket, frame: InvitePublishFrame) {
  const pk = getPk(ws);
  if (!pk) { send(ws, errorFrame("UNAUTH", "not authenticated")); return; }
  store.publishInvite(frame.invite_id, frame.blob, pk, frame.expires_at);
  send(ws, ackFrame(frame.msg_id, "delivered"));
}

async function handleInviteClaim(ws: WebSocket, frame: InviteClaimFrame) {
  const invite = store.getInvite(frame.invite_id);
  if (!invite) { send(ws, errorFrame("NOT_FOUND", "invite not found")); return; }
  if (invite.claimed_at) { send(ws, errorFrame("ALREADY_CLAIMED", "invite already used")); return; }

  const ok = store.claimInvite(frame.invite_id);
  if (!ok) { send(ws, errorFrame("ALREADY_CLAIMED", "invite already used")); return; }

  const initFrame: RoutedFrame = {
    v: PROTOCOL_VERSION,
    type: "SESSION_INIT",
    msg_id: frame.msg_id,
    ts: frame.ts,
    from: frame.from,
    to: invite.inviter_pk,
    ciphertext: frame.ciphertext,
    nonce: frame.nonce,
    sig: frame.sig,
    seq: 0,
  };

  const inviter = agents.get(invite.inviter_pk);
  if (inviter) {
    send(inviter.ws, { v: PROTOCOL_VERSION, type: "DELIVERY", msg_id: randomUUID(), ts: Date.now(), routed: initFrame });
  } else {
    store.enqueuePending(randomUUID(), invite.inviter_pk, JSON.stringify(initFrame));
  }
  send(ws, ackFrame(frame.msg_id, "queued"));
}

function handleRouted(ws: WebSocket, frame: RoutedFrame) {
  const pk = getPk(ws);
  if (!pk || pk !== frame.from) {
    send(ws, errorFrame("UNAUTH", "from mismatch"));
    return;
  }

  const maxMsgs = parseInt(process.env["MAX_PENDING_MSGS"] ?? "500", 10);
  const recipient = agents.get(frame.to);

  if (recipient) {
    send(recipient.ws, { v: PROTOCOL_VERSION, type: "DELIVERY", msg_id: randomUUID(), ts: Date.now(), routed: frame });
    send(ws, ackFrame(frame.msg_id, "delivered"));
  } else {
    if (store.countPending(frame.to) >= maxMsgs) {
      send(ws, ackFrame(frame.msg_id, "error", "recipient queue full"));
      return;
    }
    store.enqueuePending(randomUUID(), frame.to, JSON.stringify(frame));
    send(ws, ackFrame(frame.msg_id, "queued"));
  }
}

function getPk(ws: WebSocket): string | undefined {
  return (ws as unknown as Record<string, unknown>)["__pk"] as string | undefined;
}

function setPk(ws: WebSocket, pk: string) {
  (ws as unknown as Record<string, unknown>)["__pk"] = pk;
}

function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token");

  if (token) {
    const result = verifySessionToken(token);
    if (result.valid) {
      setPk(ws, result.pk);
      agents.set(result.pk, { ws, pk: result.pk });
      store.touchAgent(result.pk);
      flushPending(ws, result.pk);
    }
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("pong", () => { /* keepalive acknowledged */ });
  ws.on("ping", () => ws.pong());

  ws.on("message", async (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); }
    catch { send(ws, errorFrame("BAD_JSON", "invalid JSON")); return; }

    const result = parseFrame(parsed);
    if (!result.ok) { send(ws, errorFrame("BAD_FRAME", result.error)); return; }

    const frame = result.data;
    if (frame.type === "PING") { send(ws, { ...frame, type: "PONG" }); return; }
    if (frame.type === "PONG") return;

    if (frame.type === "HELLO") { await handleHello(ws, frame); return; }

    if (!getPk(ws)) {
      send(ws, errorFrame("UNAUTH", "authenticate first with HELLO"));
      return;
    }

    switch (frame.type) {
      case "INVITE_PUBLISH": handleInvitePublish(ws, frame); break;
      case "INVITE_CLAIM":   await handleInviteClaim(ws, frame); break;
      case "MSG":
      case "SESSION_INIT":
      case "SESSION_ACK":
        handleRouted(ws, frame);
        break;
      default:
        send(ws, errorFrame("UNKNOWN_TYPE", "unexpected frame type"));
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    const pk = getPk(ws);
    if (pk) agents.delete(pk);
  });

  ws.on("error", () => ws.close());
}

/** Attach WS server to an existing HTTP server on path /ws */
export function attachWss(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", handleConnection);

  // prune expired data every hour
  setInterval(() => {
    store.prune(parseInt(process.env["PENDING_TTL_DAYS"] ?? "7", 10));
  }, 3_600_000);

  return wss;
}
