import { describe, it, expect } from "vitest";
import { resolveAcceptServer } from "./commands/invite.js";

describe("resolveAcceptServer", () => {
  it("uses the explicit --server when given (overrides the blob)", () => {
    expect(resolveAcceptServer("wss://explicit/ws", "wss://blob/ws")).toBe("wss://explicit/ws");
  });

  it("falls back to the invite blob's server_url when --server is omitted", () => {
    expect(resolveAcceptServer(undefined, "wss://blob/ws")).toBe("wss://blob/ws");
  });

  it("returns null when neither is available", () => {
    expect(resolveAcceptServer(undefined, undefined)).toBeNull();
  });

  it("explicit wins even if the blob has no server_url", () => {
    expect(resolveAcceptServer("wss://explicit/ws", undefined)).toBe("wss://explicit/ws");
  });
});
