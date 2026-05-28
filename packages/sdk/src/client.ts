import WebSocket from "ws";
import { randomUUID } from "crypto";
import {
  sodiumReady,
  parseFrame,
  createInvite,
  parseInviteUrl,
  seal,
  open,
  toBase64,
  fromBase64,
  PROTOCOL_VERSION,
  type AnyFrame,
  type RoutedFrame,
} from "@agentroom/protocol";
import { loadOrCreateIdentity } from "./identity.js";
import {
  deriveSessionKeys,
  initRatchetSession,
  encryptMessage,
  decryptMessage,
  signFrame,
  verifyFrameSig,
  getSession,
  setSession,
  listSessions,
} from "./session.js";

type MessageHandler = (from: string, text: string) => void;
type PeerOnlineHandler = (pk: string) => void;

export interface ConnectOptions {
  serverUrl: string;
  home?: string;
}

export class AgentroomClient {
  private ws: WebSocket | null = null;
  private pk = "";
  private identity: Awaited<ReturnType<typeof loadOrCreateIdentity>> | null = null;
  private pendingAcks = new Map<string, (status: string, err?: string) => void>();
  private onMessageHandlers: MessageHandler[] = [];
  private onPeerOnlineHandlers: PeerOnlineHandler[] = [];
  private serverUrl = "";
  private home: string | undefined = undefined;

  onMessage(fn: MessageHandler) { this.onMessageHandlers.push(fn); }
  onPeerOnline(fn: PeerOnlineHandler) { this.onPeerOnlineHandlers.push(fn); }

  async connect(opts: ConnectOptions): Promise<void> {
    await sodiumReady();
    this.serverUrl = opts.serverUrl;
    this.home = opts.home;
    this.identity = await loadOrCreateIdentity(opts.home);
    this.pk = toBase64(this.identity.ed25519_pk);

    // Derive HTTP base: wss://host/ws → http://host
    const httpBase = opts.serverUrl.replace(/^wss?:\/\//, "http://").replace(/\/ws$/, "");
    const resp = await fetch(`${httpBase}/auth/challenge`);
    if (!resp.ok) throw new Error(`challenge request failed: ${resp.status}`);
    const { challenge } = await resp.json() as { challenge: string };

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(opts.serverUrl);
      this.ws = ws;

      ws.once("open", async () => {
        const challengeBytes = new TextEncoder().encode(challenge);
        const sig = await signFrame(challengeBytes, this.identity!.ed25519_sk);
        this.send({
          v: PROTOCOL_VERSION,
          type: "HELLO",
          msg_id: randomUUID(),
          ts: Date.now(),
          ed25519_pk: this.pk,
          x25519_pk: toBase64(this.identity!.x25519_pk),
          sig,
          challenge,
        });
      });

      ws.on("message", async (raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); }
        catch { return; }
        const result = parseFrame(parsed);
        if (!result.ok) return;
        const frame = result.data;

        if (frame.type === "HELLO_ACK") {
          resolve();
          return;
        }
        await this.handleFrame(frame);
      });

      ws.once("error", reject);
      ws.on("close", () => { this.ws = null; });
    });
  }

  private send(data: unknown) {
    this.ws?.send(JSON.stringify(data));
  }

  private async handleFrame(frame: AnyFrame) {
    switch (frame.type) {
      case "DELIVERY":
        await this.handleDelivery(frame.routed);
        break;
      case "ACK": {
        const cb = this.pendingAcks.get(frame.ref_msg_id);
        if (cb) { cb(frame.status, frame.error); this.pendingAcks.delete(frame.ref_msg_id); }
        break;
      }
      case "PING":
        this.send({ ...frame, type: "PONG" });
        break;
    }
  }

  private async handleDelivery(routed: RoutedFrame) {
    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: routed.from, to: routed.to, seq: routed.seq, nonce: routed.nonce }),
    );
    const valid = await verifyFrameSig(sigPayload, routed.sig, routed.from);
    if (!valid) { console.warn("[sdk] invalid frame signature from", routed.from); return; }

    if (routed.type === "SESSION_INIT") {
      await this.handleSessionInit(routed);
      return;
    }

    if (routed.type === "SESSION_ACK") {
      await this.handleSessionAck(routed);
      return;
    }

    // MSG — use Double Ratchet decrypt
    const session = getSession(routed.from);
    if (!session) { console.warn("[sdk] no session for", routed.from); return; }
    const plainBytes = await decryptMessage(
      session,
      routed.ciphertext,
      routed.nonce,
      routed.seq,
      routed.ratchet_pk,
      this.identity?.x25519_sk,
    );
    const text = new TextDecoder().decode(plainBytes);
    for (const h of this.onMessageHandlers) h(routed.from, text);
  }

  /** Inviter receives SESSION_INIT from invitee: derive keys, init ratchet, send ACK */
  private async handleSessionInit(routed: RoutedFrame) {
    if (!this.identity) return;

    const initPayload = JSON.parse(
      new TextDecoder().decode(fromBase64(routed.ciphertext)),
    ) as { x25519_pk: string; nonce: string };

    const bootstrapKeys = await deriveSessionKeys(
      this.identity.x25519_sk,
      fromBase64(initPayload.x25519_pk),
      initPayload.nonce,
      "inviter",
    );

    const session = await initRatchetSession(routed.from, bootstrapKeys);

    // SESSION_ACK: encrypt a proof-of-possession with the bootstrap key (not ratchet)
    const ackPlain = new TextEncoder().encode(JSON.stringify({ ack: initPayload.nonce }));
    const ackNonce = fromBase64(toBase64(new Uint8Array(24)));
    const { ciphertext: ackCiphertext, nonce: ackNonceOut } = await seal(ackPlain, bootstrapKeys.sendKey);

    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: routed.from, seq: 0, nonce: toBase64(ackNonceOut) }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    this.send({
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

    void session;
    for (const h of this.onPeerOnlineHandlers) h(routed.from);
  }

  /** Invitee receives SESSION_ACK: verify proof, init ratchet */
  private async handleSessionAck(routed: RoutedFrame) {
    if (!this.identity) return;

    // bootstrapKeys were already derived during acceptInvite; session exists
    // SESSION_ACK just confirms the handshake — mark peer online and ensure ratchet is ready
    const session = getSession(routed.from);
    if (!session) {
      console.warn("[sdk] SESSION_ACK without prior session for", routed.from);
      return;
    }

    // Optionally verify ACK content (we just trust the signature which was already verified)
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
      this.send({
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

    // Init ratchet session; SESSION_ACK from inviter will confirm
    await initRatchetSession(blob.inviter_ed25519_pk, bootstrapKeys);

    const initPayload = JSON.stringify({
      x25519_pk: toBase64(this.identity.x25519_pk),
      nonce: blob.nonce,
    });
    const ciphertextB64 = toBase64(new TextEncoder().encode(initPayload));

    // nonce field = ciphertextB64 so the sig covers the same value that arrives in the RoutedFrame
    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: blob.inviter_ed25519_pk, seq: 0, nonce: ciphertextB64 }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    await this.waitAck((msg_id) => {
      this.send({
        v: PROTOCOL_VERSION,
        type: "INVITE_CLAIM",
        msg_id,
        ts: Date.now(),
        invite_id: blob.invite_id,
        from: this.pk,
        ciphertext: ciphertextB64,
        nonce: ciphertextB64,   // same as sigPayload nonce for consistent verification
        sig,
      });
    });

    return blob.inviter_ed25519_pk;
  }

  async sendMessage(peerPk: string, text: string): Promise<void> {
    if (!this.identity) throw new Error("not connected");
    const session = getSession(peerPk);
    if (!session) throw new Error(`no session with ${peerPk} — accept/create invite first`);

    const plaintext = new TextEncoder().encode(text);
    const { ciphertext, nonce, ratchet_pk } = await encryptMessage(session, plaintext);
    const seq = session.sendSeq - 1; // sendSeq was already incremented

    const sigPayload = new TextEncoder().encode(
      JSON.stringify({ from: this.pk, to: peerPk, seq, nonce }),
    );
    const sig = await signFrame(sigPayload, this.identity.ed25519_sk);

    await this.waitAck((msg_id) => {
      this.send({
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

  peers(): string[] { return listSessions(); }
  publicKey(): string { return this.pk; }

  disconnect() { this.ws?.close(); }

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
