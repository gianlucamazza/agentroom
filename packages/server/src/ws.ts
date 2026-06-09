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
import {
  consumeChallenge,
  issueSessionToken,
  verifySessionToken,
  consumeHelloFailRate,
  consumeFrameRate,
} from "./auth.js";
import { inc, set } from "./metrics.js";
import { logEvent } from "./log.js";

interface ConnectedAgent {
  ws: WebSocket;
  pk: string;
}

const agents = new Map<string, ConnectedAgent>();

// WeakMap replaces the unsafe (ws as unknown)["__pk"] pattern
const wsPkMap = new WeakMap<WebSocket, string>();

function getPk(ws: WebSocket): string | undefined {
  return wsPkMap.get(ws);
}

function setPk(ws: WebSocket, pk: string) {
  wsPkMap.set(ws, pk);
}

// ── timers for graceful shutdown ──────────────────────────────────────────
const pingIntervals = new Set<ReturnType<typeof setInterval>>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function clearWssIntervals() {
  for (const t of pingIntervals) clearInterval(t);
  pingIntervals.clear();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function getWss(): WebSocketServer | null {
  return _wss;
}
let _wss: WebSocketServer | null = null;

// ── helpers ───────────────────────────────────────────────────────────────

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// A slow reader must not make the relay buffer unboundedly on its socket:
// past this threshold deliveries fall back to the pending queue instead.
const BACKPRESSURE_BYTES = 1024 * 1024;

/** True if the socket is open and its send buffer has room for a delivery. */
export function canDeliverNow(ws: WebSocket): boolean {
  return (
    ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= BACKPRESSURE_BYTES
  );
}

function errorFrame(code: string, message: string) {
  return {
    v: PROTOCOL_VERSION,
    type: "ERROR",
    msg_id: randomUUID(),
    ts: Date.now(),
    code,
    message,
  };
}

function ackFrame(
  ref_msg_id: string,
  status: "delivered" | "queued" | "error",
  error?: string,
) {
  return {
    v: PROTOCOL_VERSION,
    type: "ACK",
    msg_id: randomUUID(),
    ts: Date.now(),
    ref_msg_id,
    status,
    ...(error !== undefined ? { error } : {}),
  };
}

export function flushPending(ws: WebSocket, pk: string) {
  const pending = store.dequeuePending(pk);
  for (const { id, envelope } of pending) {
    let routed: RoutedFrame;
    try {
      routed = JSON.parse(envelope) as RoutedFrame;
    } catch {
      // a poison row would otherwise block the queue forever: drop, but loudly
      logEvent("warn", "pending.dropped_malformed", { id });
      store.deletePending(id);
      continue;
    }
    // only delete after confirming the ws is open AND not backpressured —
    // never lose messages silently, never buffer unboundedly
    if (!canDeliverNow(ws)) break;
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "DELIVERY",
      msg_id: randomUUID(),
      ts: Date.now(),
      routed,
    });
    store.deletePending(id);
  }
}

// ── frame handlers ────────────────────────────────────────────────────────

async function handleHello(ws: WebSocket, frame: HelloFrame, remoteIp: string) {
  if (!consumeChallenge(frame.challenge)) {
    send(ws, errorFrame("INVALID_CHALLENGE", "challenge expired or unknown"));
    ws.close();
    return;
  }

  const msgBytes = new TextEncoder().encode(frame.challenge);
  const valid = await verify(
    msgBytes,
    fromBase64(frame.sig),
    fromBase64(frame.ed25519_pk),
  );
  if (!valid) {
    inc("hello_failures");
    logEvent("warn", "hello.fail", {
      ip: remoteIp,
      pk: frame.ed25519_pk.slice(0, 8),
    });
    if (!consumeHelloFailRate(remoteIp)) {
      inc("rate_limit_hits");
      send(ws, errorFrame("RATE_LIMIT", "too many authentication failures"));
      ws.close(1008, "RATE_LIMIT");
      return;
    }
    send(ws, errorFrame("INVALID_SIG", "signature verification failed"));
    ws.close();
    return;
  }

  store.upsertAgent(frame.ed25519_pk, frame.x25519_pk);
  const session_token = issueSessionToken(frame.ed25519_pk);

  send(ws, {
    v: PROTOCOL_VERSION,
    type: "HELLO_ACK",
    msg_id: randomUUID(),
    ts: Date.now(),
    session_token,
  });

  // close any previous WS for this pk before registering the new one (prevents ghost connections)
  const existing = agents.get(frame.ed25519_pk);
  if (
    existing &&
    existing.ws !== ws &&
    existing.ws.readyState === WebSocket.OPEN
  ) {
    existing.ws.close(1000, "replaced by new connection");
  }

  setPk(ws, frame.ed25519_pk);
  agents.set(frame.ed25519_pk, { ws, pk: frame.ed25519_pk });
  set("ws_connections", agents.size);
  logEvent("info", "hello.success", { pk: frame.ed25519_pk.slice(0, 8) });
  flushPending(ws, frame.ed25519_pk);
}

function handleInvitePublish(ws: WebSocket, frame: InvitePublishFrame) {
  const pk = getPk(ws);
  if (!pk) {
    send(ws, errorFrame("UNAUTH", "not authenticated"));
    return;
  }
  const maxInvites = parseInt(process.env["MAX_INVITES_PER_PK"] ?? "20", 10);
  if (store.countOpenInvitesByPk(pk) >= maxInvites) {
    send(ws, errorFrame("INVITE_QUOTA", "too many unclaimed invites"));
    return;
  }
  // expires_at is client-controlled (epoch ms): clamp it so one agent cannot
  // park invites in the DB forever
  const maxExpiresAt = Date.now() + 7 * 24 * 3_600_000;
  store.publishInvite(
    frame.invite_id,
    frame.blob,
    pk,
    Math.min(frame.expires_at, maxExpiresAt),
  );
  send(ws, ackFrame(frame.msg_id, "delivered"));
}

async function handleInviteClaim(ws: WebSocket, frame: InviteClaimFrame) {
  const invite = store.getInvite(frame.invite_id);
  if (!invite) {
    send(ws, errorFrame("NOT_FOUND", "invite not found"));
    return;
  }
  if (invite.claimed_at) {
    send(ws, errorFrame("ALREADY_CLAIMED", "invite already used"));
    return;
  }
  if (invite.expires_at <= Date.now()) {
    send(ws, errorFrame("EXPIRED", "invite expired"));
    return;
  }

  // verify that frame.from actually signed this claim.
  // Without this check, any authenticated user could claim any invite with an arbitrary "from" pk.
  const sigPayload = new TextEncoder().encode(
    JSON.stringify({
      from: frame.from,
      to: invite.inviter_pk,
      seq: 0,
      nonce: frame.nonce,
    }),
  );
  const claimSigValid = await verify(
    sigPayload,
    fromBase64(frame.sig),
    fromBase64(frame.from),
  );
  if (!claimSigValid) {
    logEvent("warn", "invite_claim.invalid_sig", {
      from: frame.from.slice(0, 8),
      invite_id: frame.invite_id,
    });
    send(
      ws,
      errorFrame("INVALID_SIG", "INVITE_CLAIM signature verification failed"),
    );
    return;
  }

  // Apply same cap as handleRouted to prevent queue amplification. The cap
  // must hold whenever we would enqueue — inviter offline OR backpressured.
  const maxMsgs = parseInt(process.env["MAX_PENDING_MSGS"] ?? "500", 10);
  const inviter = agents.get(invite.inviter_pk);
  const deliverNow = inviter !== undefined && canDeliverNow(inviter.ws);
  if (!deliverNow && store.countPending(invite.inviter_pk) >= maxMsgs) {
    send(ws, ackFrame(frame.msg_id, "error", "recipient queue full"));
    return;
  }

  const ok = store.claimInvite(frame.invite_id);
  if (!ok) {
    send(ws, errorFrame("ALREADY_CLAIMED", "invite already used"));
    return;
  }

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

  if (deliverNow && inviter) {
    send(inviter.ws, {
      v: PROTOCOL_VERSION,
      type: "DELIVERY",
      msg_id: randomUUID(),
      ts: Date.now(),
      routed: initFrame,
    });
  } else {
    store.enqueuePending(
      randomUUID(),
      invite.inviter_pk,
      JSON.stringify(initFrame),
    );
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

  // a backpressured recipient is treated as offline: queue instead of
  // piling more bytes onto its socket buffer
  if (recipient && canDeliverNow(recipient.ws)) {
    send(recipient.ws, {
      v: PROTOCOL_VERSION,
      type: "DELIVERY",
      msg_id: randomUUID(),
      ts: Date.now(),
      routed: frame,
    });
    send(ws, ackFrame(frame.msg_id, "delivered"));
    inc("messages_routed_total");
  } else {
    if (store.countPending(frame.to) >= maxMsgs) {
      send(ws, ackFrame(frame.msg_id, "error", "recipient queue full"));
      return;
    }
    store.enqueuePending(randomUUID(), frame.to, JSON.stringify(frame));
    send(ws, ackFrame(frame.msg_id, "queued"));
    inc("messages_routed_total");
  }
}

function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const remoteIp = req.socket?.remoteAddress ?? "unknown";
  const url = new URL(req.url ?? "/", "http://localhost");
  // Preferred: Authorization header (query strings end up in proxy/tunnel
  // access logs). The ?token= query param is kept one release for clients
  // ≤1.15, then will be removed.
  const authHeader = req.headers["authorization"];
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
  const token = headerToken ?? url.searchParams.get("token");

  if (token) {
    const result = verifySessionToken(token);
    if (result.valid) {
      setPk(ws, result.pk);
      agents.set(result.pk, { ws, pk: result.pk });
      store.touchAgent(result.pk);
      set("ws_connections", agents.size);
      flushPending(ws, result.pk);
    } else {
      // documented contract (PROTOCOL.md "Fast Reconnect"): reject the resume
      // explicitly so the client falls back to HELLO right away instead of
      // hanging until the first server keepalive
      send(ws, errorFrame("UNAUTH", "invalid or expired session token"));
    }
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);
  pingIntervals.add(pingInterval);

  ws.on("pong", () => {
    /* keepalive acknowledged */
  });
  ws.on("ping", () => ws.pong());

  ws.on("message", async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, errorFrame("BAD_JSON", "invalid JSON"));
      return;
    }

    const result = parseFrame(parsed);
    if (!result.ok) {
      send(ws, errorFrame("BAD_FRAME", result.error));
      return;
    }

    const frame = result.data;

    // rate-limit every frame from an authenticated socket, app-level PING/PONG
    // included — keepalives must not be a free flood channel
    const authedPk = getPk(ws);
    if (authedPk && !consumeFrameRate(authedPk)) {
      inc("rate_limit_hits");
      send(ws, errorFrame("RATE_LIMIT", "too many frames"));
      return;
    }

    if (frame.type === "PING") {
      send(ws, { ...frame, type: "PONG" });
      return;
    }
    if (frame.type === "PONG") return;

    if (frame.type === "HELLO") {
      await handleHello(ws, frame, remoteIp);
      return;
    }

    if (!authedPk) {
      send(ws, errorFrame("UNAUTH", "authenticate first with HELLO"));
      return;
    }

    switch (frame.type) {
      case "INVITE_PUBLISH":
        handleInvitePublish(ws, frame);
        break;
      case "INVITE_CLAIM":
        await handleInviteClaim(ws, frame);
        break;
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
    pingIntervals.delete(pingInterval);
    clearInterval(pingInterval);
    const pk = getPk(ws);
    // only delete if this WS is still the registered one
    // (handleHello may have replaced agents[pk] with a new WS before this close fires)
    if (pk && agents.get(pk)?.ws === ws) {
      agents.delete(pk);
      set("ws_connections", agents.size);
    }
  });

  ws.on("error", () => ws.close());
}

/** Attach WS server to an existing HTTP server on path /ws */
export function attachWss(httpServer: Server): WebSocketServer {
  // ws closes oversized frames with 1009 before they reach JSON.parse —
  // bounds memory per frame (schema field limits bound the content further)
  const maxPayload = parseInt(
    process.env["WS_MAX_PAYLOAD"] ?? String(256 * 1024),
    10,
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  _wss = wss;

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const maxConns = parseInt(process.env["MAX_CONNECTIONS"] ?? "500", 10);
    if (wss.clients.size >= maxConns) {
      logEvent("warn", "upgrade.refused", { reason: "max_connections" });
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", handleConnection);

  // prune expired data every hour
  pruneTimer = setInterval(() => {
    store.prune(parseInt(process.env["PENDING_TTL_DAYS"] ?? "7", 10));
  }, 3_600_000);
  pruneTimer.unref?.();

  return wss;
}
