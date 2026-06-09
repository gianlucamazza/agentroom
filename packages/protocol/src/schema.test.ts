import { describe, it, expect } from "vitest";
import { parseFrame } from "./schema.js";
import { PROTOCOL_VERSION } from "./frames.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function ping(over: Record<string, unknown> = {}) {
  return { v: PROTOCOL_VERSION, type: "PING", msg_id: UUID, ts: 1, ...over };
}

function routed(over: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: "MSG",
    msg_id: UUID,
    ts: 1,
    from: "a",
    to: "b",
    ciphertext: "c",
    nonce: "n",
    sig: "s",
    seq: 0,
    ...over,
  };
}

describe("parseFrame", () => {
  it("accepts a valid PING frame", () => {
    const r = parseFrame(ping());
    expect(r.ok).toBe(true);
  });

  it("accepts a valid MSG (routed) frame with optional ratchet_pk", () => {
    expect(parseFrame(routed()).ok).toBe(true);
    expect(parseFrame(routed({ ratchet_pk: "rk" })).ok).toBe(true);
  });

  it("rejects a non-object / null / undefined", () => {
    expect(parseFrame(null).ok).toBe(false);
    expect(parseFrame(undefined).ok).toBe(false);
    expect(parseFrame("nope").ok).toBe(false);
    expect(parseFrame(42).ok).toBe(false);
  });

  it("rejects an unknown frame type", () => {
    expect(parseFrame(ping({ type: "WAT" })).ok).toBe(false);
  });

  it("rejects a missing type", () => {
    const { type: _omit, ...noType } = ping();
    expect(parseFrame(noType).ok).toBe(false);
  });

  it("rejects an unsupported protocol version", () => {
    expect(parseFrame(ping({ v: 99 })).ok).toBe(false);
  });

  it("rejects a non-uuid msg_id", () => {
    expect(parseFrame(ping({ msg_id: "not-a-uuid" })).ok).toBe(false);
  });

  it("rejects a non-integer / non-positive ts", () => {
    expect(parseFrame(ping({ ts: 1.5 })).ok).toBe(false);
    expect(parseFrame(ping({ ts: 0 })).ok).toBe(false);
    expect(parseFrame(ping({ ts: -1 })).ok).toBe(false);
  });

  it("rejects a routed frame with negative seq", () => {
    expect(parseFrame(routed({ seq: -1 })).ok).toBe(false);
  });

  it("rejects a routed frame with missing required fields", () => {
    const { ciphertext: _c, ...noCipher } = routed();
    expect(parseFrame(noCipher).ok).toBe(false);
    const { sig: _s, ...noSig } = routed();
    expect(parseFrame(noSig).ok).toBe(false);
  });

  it("rejects empty base64 fields (min length 1)", () => {
    expect(parseFrame(routed({ ciphertext: "" })).ok).toBe(false);
  });

  it("surfaces a non-empty error string on failure", () => {
    const r = parseFrame(ping({ type: "WAT" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
