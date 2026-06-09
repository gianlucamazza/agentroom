import { z } from "zod";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_V1 } from "./frames.js";

const base = z.object({
  v: z.union([z.literal(PROTOCOL_VERSION), z.literal(PROTOCOL_VERSION_V1)]),
  msg_id: z.uuid(),
  ts: z.number().int().positive(),
});

const b64 = z.string().min(1);

export const HelloSchema = base.extend({
  type: z.literal("HELLO"),
  ed25519_pk: b64,
  x25519_pk: b64,
  sig: b64,
  challenge: z.string().min(1),
});

export const HelloAckSchema = base.extend({
  type: z.literal("HELLO_ACK"),
  session_token: z.string().min(1),
});

export const InvitePublishSchema = base.extend({
  type: z.literal("INVITE_PUBLISH"),
  invite_id: z.uuid(),
  blob: b64,
  expires_at: z.number().int().positive(),
});

export const InviteClaimSchema = base.extend({
  type: z.literal("INVITE_CLAIM"),
  invite_id: z.uuid(),
  from: b64,
  ciphertext: b64,
  nonce: b64,
  sig: b64,
});

export const RoutedSchema = base.extend({
  type: z.enum(["MSG", "SESSION_INIT", "SESSION_ACK"]),
  from: b64,
  to: b64,
  ciphertext: b64,
  nonce: b64,
  sig: b64,
  seq: z.number().int().nonnegative(),
  ratchet_pk: b64.optional(),
});

export const AckSchema = base.extend({
  type: z.literal("ACK"),
  ref_msg_id: z.uuid(),
  status: z.enum(["delivered", "queued", "error"]),
  error: z.string().optional(),
});

export const DeliverySchema = base.extend({
  type: z.literal("DELIVERY"),
  routed: RoutedSchema,
});

export const PingSchema = base.extend({ type: z.literal("PING") });
export const PongSchema = base.extend({ type: z.literal("PONG") });

export const ErrorSchema = base.extend({
  type: z.literal("ERROR"),
  code: z.string(),
  message: z.string(),
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

export function parseFrame(raw: unknown): ParseResult<z.infer<typeof AnyFrameSchema>> {
  const result = AnyFrameSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.message };
}
