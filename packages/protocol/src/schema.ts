import { z } from "zod";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_V1 } from "./frames.js";

const base = z.object({
  v: z.union([z.literal(PROTOCOL_VERSION), z.literal(PROTOCOL_VERSION_V1)]),
  msg_id: z.uuid(),
  ts: z.number().int().positive(),
});

// Field size bounds (DoS hardening): every inbound frame is validated, so
// oversized fields are rejected at the protocol layer before any handling.
const b64 = z.string().min(1).max(512); // keys, sigs, nonces (raw ≤ 256 bytes)
const b64Blob = z.string().min(1).max(16_384); // signed invite blob
const b64Cipher = z.string().min(1).max(196_608); // sealed payload (~144 KiB plaintext)

export const HelloSchema = base.extend({
  type: z.literal("HELLO"),
  ed25519_pk: b64,
  x25519_pk: b64,
  sig: b64,
  challenge: z.string().min(1).max(256),
});

export const HelloAckSchema = base.extend({
  type: z.literal("HELLO_ACK"),
  session_token: z.string().min(1).max(512),
});

export const InvitePublishSchema = base.extend({
  type: z.literal("INVITE_PUBLISH"),
  invite_id: z.uuid(),
  blob: b64Blob,
  expires_at: z.number().int().positive(),
});

export const InviteClaimSchema = base.extend({
  type: z.literal("INVITE_CLAIM"),
  invite_id: z.uuid(),
  from: b64,
  ciphertext: b64Cipher,
  nonce: b64,
  sig: b64,
});

export const RoutedSchema = base.extend({
  type: z.enum(["MSG", "SESSION_INIT", "SESSION_ACK"]),
  from: b64,
  to: b64,
  ciphertext: b64Cipher,
  nonce: b64,
  sig: b64,
  seq: z.number().int().nonnegative(),
  ratchet_pk: b64.optional(),
});

export const AckSchema = base.extend({
  type: z.literal("ACK"),
  ref_msg_id: z.uuid(),
  status: z.enum(["delivered", "queued", "error"]),
  error: z.string().max(1024).optional(),
});

export const DeliverySchema = base.extend({
  type: z.literal("DELIVERY"),
  routed: RoutedSchema,
});

export const PingSchema = base.extend({ type: z.literal("PING") });
export const PongSchema = base.extend({ type: z.literal("PONG") });

export const ErrorSchema = base.extend({
  type: z.literal("ERROR"),
  code: z.string().max(64),
  message: z.string().max(1024),
});

export const AnyFrameSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HelloAckSchema,
  InvitePublishSchema,
  InviteClaimSchema,
  RoutedSchema,
  AckSchema,
  DeliverySchema,
  PingSchema,
  PongSchema,
  ErrorSchema,
]);

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function parseFrame(
  raw: unknown,
): ParseResult<z.infer<typeof AnyFrameSchema>> {
  const result = AnyFrameSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.message };
}
