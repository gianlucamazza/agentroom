import WebSocket from "ws";
import { randomUUID } from "crypto";
import {
  sodiumReady,
  parseFrame,
  createInvite,
  parseInviteUrl,
  seal,
  toBase64,
  fromBase64,
  PROTOCOL_VERSION,
  type AnyFrame,
  type RoutedFrame,
} from "@agentroom/protocol";
import { loadOrCreateIdentity, loadAllSessions, saveSession } from "./identity.js";
import {
  SessionStore,
  deriveSessionKeys,
  encryptMessage,
  decryptMessage,
  signFrame,
  verifyFrameSig,
  pruneSkippedInPlace,
} from "./session.js";

type MessageHandler = (from: string, text: string) => void;
type PeerOnlineHandler = (pk: string) => void;
type DisconnectHandler = (reason: string) => void;
type ReconnectHandler = () => void;
type ReconnectFailedHandler = (reason: string) => void;

export interface ConnectOptions {
  serverUrl: string;
  home?: string;
  /** Auto-reconnect on drop. Default: false. Enable for long-lived listeners. */
  autoReconnect?: boolean;
  /** Reconnect behavior overrides */
  reconnect?: {
    maxAttempts?: number;   // default: Infinity
    maxBackoffMs?: number;  // default: 60_000
  };
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
const PRUNE_INTERVAL_MS = 5 * 60_000;

export class AgentroomClient {
  private ws: WebSocket | null = null;
  private pk = "";
  private identity: Awaited<ReturnType<typeof loadOrCreateIdentity>> | null = null;
  private pendingAcks = new Map<string, (status: string, err?: string) => void>();
  private onMessageHandlers: MessageHandler[] = [];
  private onPeerOnlineHandlers: PeerOnlineHandler[] = [];
  private onDisconnectHandlers: DisconnectHandler[] = [];
  private onReconnectHandlers: ReconnectHandler[] = [];
  private onReconnectFailedHandlers: ReconnectFailedHandler[] = [];
  private serverUrl = "";
  private home: string | undefined = undefined;
  private sessionToken: string | null = null;
  private reconnectEnabled = false;
  private reconnectAttempt = 0;
  private reconnectMaxAttempts = Infinity;
  private reconnectMaxBackoffMs = 60_000;
  private destroyed = false;
  private currentReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  // C4: per-instance session store — no cross-client contamination
  private store = new SessionStore();
  // A4: AbortController to cancel in-flight fetch on disconnect
  private connectAbort: AbortController | null = null;

  onMessage(fn: MessageHandler) { this.onMessageHandlers.push(fn); }
  onPeerOnline(fn: PeerOnlineHandler) { this.onPeerOnlineHandlers.push(fn); }
  onDisconnect(fn: DisconnectHandler) { this.onDisconnectHandlers.push(fn); }
  onReconnect(fn: ReconnectHandler) { this.onReconnectHandlers.push(fn); }
  onReconnectFailed(fn: ReconnectFailedHandler) { this.onReconnectFailedHandlers.push(fn); }

  async connect(opts: ConnectOptions): Promise<void> {
    await sodiumReady();
    this.serverUrl = opts.serverUrl;
    this.home = opts.home;
    this.reconnectEnabled = opts.autoReconnect ?? false;
    this.reconnectMaxAttempts = opts.reconnect?.maxAttempts ?? Infinity;
    this.reconnectMaxBackoffMs = opts.reconnect?.maxBackoffMs ?? 60_000;
    this.identity = await loadOrCreateIdentity(opts.home);
    this.pk = toBase64(this.identity.ed25519_pk);

    // Load persisted sessions into this instance's store (C4: per-instance)
    for (const state of loadAllSessions(opts.home)) {
      this.store.set(state.peerPk, state);
    }

    // Prune skipped keys for all loaded sessions
    this._pruneAllSkippedKeys();

    await this._doConnect();
    this.reconnectAttempt = 0;

    // Periodic prune of skipped keys
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this._pruneAllSkippedKeys(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();
    }
  }

  /** Inner connect — also used for reconnect. */
  private async _doConnect(): Promise<void> {
    if (!this.identity) throw new Error("identity not loaded");

    // Fast-path: reconnect with existing session token
    if (this.sessionToken) {
      const tokenUrl = `${this.serverUrl}?token=${encodeURIComponent(this.sessionToken)}`;
      const connected = await this._openWs(tokenUrl, false);
      if (connected) return;
      // Token rejected → fall through to full HELLO
      this.sessionToken = null;
    }

    // Full HELLO handshake — fetch challenge with AbortController (A4)
    const httpBase = this.serverUrl.replace(/^wss?:\/\//, "http://").replace(/\/ws$/, "");
    this.connectAbort = new AbortController();
    let resp: Response;
    try {
      resp = await fetch(`${httpBase}/auth/challenge`, { signal: this.connectAbort.signal });
    } finally {
      this.connectAbort = null;
    }
    if (!resp.ok) {
      const hint = resp.status === 429 ? " (rate limited — retry in ~60s)" : "";
      throw new Error(`challenge request failed: ${resp.status}${hint}`);
    }
    const { challenge } = await resp.json() as { challenge: string };
    await this._openWs(this.serverUrl, true, challenge);
  }

  /**
   * Open WS connection.
   * If `withHello=true` sends a HELLO frame; otherwise waits for first DELIVERY or ERROR.
   * Returns true on success, false if rejected (token expired etc.).
   */
  private _openWs(wsUrl: string, withHello: true, challenge: string): Promise<void>;
  private _openWs(wsUrl: string, withHello: false): Promise<boolean>;
  private _openWs(wsUrl: string, withHello: boolean, challenge?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.once("open", async () => {
        if (!withHello) return; // token auth: just wait for server-side flush
        const challengeBytes = new TextEncoder().encode(challenge!);
        const sig = await signFrame(challengeBytes, this.identity!.ed25519_sk);
        this._sendRaw({
          v: PROTOCOL_VERSION,
          type: "HELLO",
          msg_id: randomUUID(),
          ts: Date.now(),
          ed25519_pk: this.pk,
          x25519_pk: toBase64(this.identity!.x25519_pk),
          sig,
          challenge: challenge!,
        });
      });

      const onFirstMessage = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); }
        catch { return; }
        const result = parseFrame(parsed);
        if (!result.ok) return;
        const frame = result.data;

        if (frame.type === "HELLO_ACK") {
          this.sessionToken = frame.session_token;
          ws.off("message", onFirstMessage);
          ws.on("message", this._handleRawMessage.bind(this));
          if (withHello) (resolve as () => void)();
          return;
        }

        if (frame.type === "ERROR" && !withHello) {
          // Token rejected
          ws.close();
          (resolve as (v: boolean) => void)(false);
          return;
        }

        // Token-auth: no HELLO_ACK, server just starts delivering pending — treat as connected
        if (!withHello) {
          ws.off("message", onFirstMessage);
          ws.on("message", this._handleRawMessage.bind(this));
          (resolve as (v: boolean) => void)(true);
          // Re-process this first message
          await this._handleRawMessage(raw);
        }
      };

      ws.on("message", onFirstMessage);
      ws.once("error", (e) => reject(e));
      ws.on("close", (code, reason) => {
        ws.off("message", onFirstMessage);
        this.ws = null;
        const reasonStr = reason?.toString() || `code ${code}`;

        if (!withHello && code !== 1000) {
          // Token connect failed before completing
          (resolve as (v: boolean) => void)(false);
          return;
        }

        if (this.reconnectEnabled && !this.destroyed) {
          for (const h of this.onDisconnectHandlers) h(reasonStr);
          void this._scheduleReconnect();
        }
      });
    });
  }

  private async _handleRawMessage(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); }
    catch { return; }
    const result = parseFrame(parsed);
    if (!result.ok) return;
    // A2: wrap in try/catch to prevent unhandled rejection crashing the process
    try {
      await this._handleFrame(result.data);
    } catch (err) {
      console.warn("[sdk] error handling frame:", err instanceof Error ? err.message : err);
    }
  }

  private async _scheduleReconnect(): Promise<void> {
    if (this.destroyed || !this.reconnectEnabled) return;
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      const reason = `max reconnect attempts (${this.reconnectMaxAttempts}) reached`;
      for (const h of this.onReconnectFailedHandlers) h(reason);
      return;
    }

    const backoffSteps = DEFAULT_BACKOFF.map((ms) => Math.min(ms, this.reconnectMaxBackoffMs));
    const delay = backoffSteps[Math.min(this.reconnectAttempt, backoffSteps.length - 1)] ?? this.reconnectMaxBackoffMs;
    this.reconnectAttempt++;

    await new Promise<void>((resolve) => {
      this.currentReconnectTimer = setTimeout(resolve, delay);
    });
    this.currentReconnectTimer = null;

    if (this.destroyed) return;
    try {
      await this._doConnect();
      this.reconnectAttempt = 0;
      for (const h of this.onReconnectHandlers) h();
    } catch {
      if (!this.destroyed && this.reconnectEnabled) void this._scheduleReconnect();
    }
  }

  private _sendRaw(data: unknown) {
    this.ws?.send(JSON.stringify(data));
  }

  private async _handleFrame(frame: AnyFrame) {
    switch (frame.type) {
      case "DELIVERY":
        await this._handleDelivery(frame.routed);
        break;
      case "ACK": {
        const cb = this.pendingAcks.get(frame.ref_msg_id);
        if (cb) { cb(frame.status, frame.error); this.pendingAcks.delete(frame.ref_msg_id); }
        break;
      }
      case "PING":
        this._sendRaw({ ...frame, type: "PONG" });
        break;
    }
  }

  private async _handleDelivery(routed: RoutedFrame) {
    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: routed.from, to: routed.to, seq: routed.seq, nonce: routed.nonce }),
    );
    const valid = await verifyFrameSig(sigPayload, routed.sig, routed.from);
    if (!valid) { console.warn("[sdk] invalid frame signature from", routed.from); return; }

    if (routed.type === "SESSION_INIT") { await this._handleSessionInit(routed); return; }
    if (routed.type === "SESSION_ACK")  { await this._handleSessionAck(routed); return; }

    // MSG
    const session = this.store.get(routed.from);
    if (!session) { console.warn("[sdk] no session for", routed.from); return; }
    const plainBytes = await decryptMessage(
      session,
      routed.ciphertext,
      routed.nonce,
      routed.seq,
      routed.ratchet_pk,
      this.identity?.x25519_sk,
    );
    // Persist updated session state
    saveSession(session.peerPk, session, this.home);
    const text = new TextDecoder().decode(plainBytes);
    for (const h of this.onMessageHandlers) h(routed.from, text);
  }

  private async _handleSessionInit(routed: RoutedFrame) {
    if (!this.identity) return;

    // C2 security: never overwrite an existing session with a new SESSION_INIT.
    // A malicious authenticated peer could send spurious SESSION_INIT to destroy sessions.
    if (this.store.has(routed.from)) {
      console.warn("[sdk] ignoring duplicate SESSION_INIT from", routed.from.slice(0, 8));
      return;
    }

    const initPayload = JSON.parse(
      new TextDecoder().decode(fromBase64(routed.ciphertext)),
    ) as { x25519_pk: string; nonce: string };

    const bootstrapKeys = await deriveSessionKeys(
      this.identity.x25519_sk,
      fromBase64(initPayload.x25519_pk),
      initPayload.nonce,
      "inviter",
    );

    const session = await this.store.init(routed.from, bootstrapKeys);
    saveSession(session.peerPk, session, this.home);

    const ackPlain = new TextEncoder().encode(JSON.stringify({ ack: initPayload.nonce }));
    const { ciphertext: ackCiphertext, nonce: ackNonceOut } = await seal(ackPlain, bootstrapKeys.sendKey);

    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: routed.from, seq: 0, nonce: toBase64(ackNonceOut) }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    this._sendRaw({
      v: PROTOCOL_VERSION,
      type: "SESSION_ACK",
      msg_id: randomUUID(),
      ts: Date.now(),
      from: this.pk,
      to: routed.from,
      ciphertext: toBase64(ackCiphertext),
      nonce: toBase64(ackNonceOut),
      sig,
      seq: 0,
    });

    for (const h of this.onPeerOnlineHandlers) h(routed.from);
  }

  private async _handleSessionAck(routed: RoutedFrame) {
    const session = this.store.get(routed.from);
    if (!session) { console.warn("[sdk] SESSION_ACK without prior session for", routed.from); return; }
    saveSession(session.peerPk, session, this.home);
    for (const h of this.onPeerOnlineHandlers) h(routed.from);
  }

  async createInvite(serverUrl?: string): Promise<{ url: string; invite_id: string }> {
    if (!this.identity) throw new Error("not connected");
    const url = serverUrl ?? this.serverUrl;
    const { signed, url: inviteUrl } = await createInvite(
      this.identity.ed25519_pk,
      this.identity.ed25519_sk,
      this.identity.x25519_pk,
      url,
    );

    await this.waitAck((msg_id) => {
      this._sendRaw({
        v: PROTOCOL_VERSION,
        type: "INVITE_PUBLISH",
        msg_id,
        ts: Date.now(),
        invite_id: signed.blob.invite_id,
        blob: toBase64(new TextEncoder().encode(JSON.stringify(signed))),
        expires_at: signed.blob.expires_at,
      });
    });

    return { url: inviteUrl, invite_id: signed.blob.invite_id };
  }

  async acceptInvite(inviteUrl: string): Promise<string> {
    if (!this.identity) throw new Error("not connected");

    const result = await parseInviteUrl(inviteUrl);
    if (!result.ok) throw new Error(result.error);
    const { blob } = result.signed;

    const bootstrapKeys = await deriveSessionKeys(
      this.identity.x25519_sk,
      fromBase64(blob.inviter_x25519_pk),
      blob.nonce,
      "invitee",
    );

    const session = await this.store.init(blob.inviter_ed25519_pk, bootstrapKeys);
    saveSession(session.peerPk, session, this.home);

    const initPayload = JSON.stringify({
      x25519_pk: toBase64(this.identity.x25519_pk),
      nonce: blob.nonce,
    });
    const ciphertextB64 = toBase64(new TextEncoder().encode(initPayload));

    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: blob.inviter_ed25519_pk, seq: 0, nonce: ciphertextB64 }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    await this.waitAck((msg_id) => {
      this._sendRaw({
        v: PROTOCOL_VERSION,
        type: "INVITE_CLAIM",
        msg_id,
        ts: Date.now(),
        invite_id: blob.invite_id,
        from: this.pk,
        ciphertext: ciphertextB64,
        nonce: ciphertextB64,
        sig,
      });
    });

    return blob.inviter_ed25519_pk;
  }

  async sendMessage(peerPk: string, text: string): Promise<void> {
    if (!this.identity) throw new Error("not connected");
    const session = this.store.get(peerPk);
    if (!session) {
      throw new Error(
        `No session with ${peerPk}.\nRun first: agentroom invite create --server <url>` +
        `\nor: agentroom invite accept '<url>' --server <url>`,
      );
    }

    const plaintext = new TextEncoder().encode(text);
    const { ciphertext, nonce, ratchet_pk } = await encryptMessage(session, plaintext);
    const seq = session.sendSeq - 1;

    // Persist updated session before sending (so even if ACK fails, state is consistent)
    saveSession(session.peerPk, session, this.home);

    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: peerPk, seq, nonce }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    await this.waitAck((msg_id) => {
      this._sendRaw({
        v: PROTOCOL_VERSION,
        type: "MSG",
        msg_id,
        ts: Date.now(),
        from: this.pk,
        to: peerPk,
        ciphertext,
        nonce,
        sig,
        seq,
        ratchet_pk,
      });
    });
  }

  peers(): string[] { return this.store.list(); }
  publicKey(): string { return this.pk; }

  disconnect() {
    this.destroyed = true;
    this.reconnectEnabled = false;

    // A4: abort any in-flight challenge fetch
    this.connectAbort?.abort();
    this.connectAbort = null;

    // Cancel any pending reconnect timer
    if (this.currentReconnectTimer) {
      clearTimeout(this.currentReconnectTimer);
      this.currentReconnectTimer = null;
    }

    // Cancel prune timer
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    // Drain pending ACKs immediately
    for (const [msg_id, cb] of this.pendingAcks) {
      cb("error", "client disconnected");
      this.pendingAcks.delete(msg_id);
    }

    // Save all active sessions before closing
    for (const peerPk of this.store.list()) {
      const session = this.store.get(peerPk);
      if (session) {
        try { saveSession(peerPk, session, this.home); } catch { /* best-effort */ }
      }
    }

    this.ws?.close();
  }

  private _pruneAllSkippedKeys() {
    for (const peerPk of this.store.list()) {
      const session = this.store.get(peerPk);
      if (session) {
        pruneSkippedInPlace(session);
        try { saveSession(peerPk, session, this.home); } catch { /* best-effort */ }
      }
    }
  }

  private waitAck(send: (msg_id: string) => void): Promise<void> {
    const msg_id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(msg_id);
        reject(new Error("ACK timeout"));
      }, 10_000);
      this.pendingAcks.set(msg_id, (status, err) => {
        clearTimeout(timeout);
        if (status === "error") reject(new Error(err ?? "server error"));
        else resolve();
      });
      send(msg_id);
    });
  }
}
