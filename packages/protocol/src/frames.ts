/** Protocol version — v1: static DH sessions; v2: adds Double Ratchet */
export const PROTOCOL_VERSION = 2 as const;
export const PROTOCOL_VERSION_V1 = 1 as const;

export type FrameType =
  | "HELLO"
  | "HELLO_ACK"
  | "INVITE_PUBLISH"
  | "INVITE_CLAIM"
  | "SESSION_INIT"
  | "SESSION_ACK"
  | "MSG"
  | "ACK"
  | "DELIVERY"
  | "PING"
  | "PONG"
  | "ERROR";

/** Base envelope: every frame sent over WS has this shape */
export interface BaseFrame {
  v: typeof PROTOCOL_VERSION | typeof PROTOCOL_VERSION_V1;
  type: FrameType;
  msg_id: string;
  ts: number;
}

/** Authenticate a WebSocket connection */
export interface HelloFrame extends BaseFrame {
  type: "HELLO";
  ed25519_pk: string;
  x25519_pk: string;
  /** sig(challenge_token, ed25519_sk) */
  sig: string;
  challenge: string;
}

export interface HelloAckFrame extends BaseFrame {
  type: "HELLO_ACK";
  /** short-lived HMAC session token, passed as ?token= on subsequent frames */
  session_token: string;
}

/** Inviter publishes an invite blob to the relay (server stores it opaquely) */
export interface InvitePublishFrame extends BaseFrame {
  type: "INVITE_PUBLISH";
  invite_id: string;
  /** base64url-encoded signed InviteBlob */
  blob: string;
  expires_at: number;
}

/** Invitee claims an invite by ID and sends its SESSION_INIT payload inline */
export interface InviteClaimFrame extends BaseFrame {
  type: "INVITE_CLAIM";
  invite_id: string;
  from: string;
  /** base64url(ciphertext) — the SESSION_INIT payload E2E-encrypted */
  ciphertext: string;
  nonce: string;
  sig: string;
}

/** Relay-routed frame (MSG, SESSION_INIT, SESSION_ACK) */
export interface RoutedFrame extends BaseFrame {
  type: "MSG" | "SESSION_INIT" | "SESSION_ACK";
  from: string;
  to: string;
  ciphertext: string;
  nonce: string;
  sig: string;
  /** monotonic counter per (from, to) direction, replay protection */
  seq: number;
  /** v2 Double Ratchet: sender's new ephemeral X25519 public key (MSG only) */
  ratchet_pk?: string;
}

/** Server delivery receipt to sender */
export interface AckFrame extends BaseFrame {
  type: "ACK";
  ref_msg_id: string;
  status: "delivered" | "queued" | "error";
  error?: string;
}

/** Server notifies recipient of incoming message */
export interface DeliveryFrame extends BaseFrame {
  type: "DELIVERY";
  routed: RoutedFrame;
}

export interface PingFrame extends BaseFrame {
  type: "PING";
}

export interface PongFrame extends BaseFrame {
  type: "PONG";
}

export interface ErrorFrame extends BaseFrame {
  type: "ERROR";
  code: string;
  message: string;
}

export type AnyFrame =
  | HelloFrame
  | HelloAckFrame
  | InvitePublishFrame
  | InviteClaimFrame
  | RoutedFrame
  | AckFrame
  | DeliveryFrame
  | PingFrame
  | PongFrame
  | ErrorFrame;
