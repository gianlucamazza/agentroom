import { describe, it, expect, beforeAll } from "vitest";
import { sodiumReady } from "@agentroom/protocol";

beforeAll(async () => {
  process.env["HMAC_SECRET"] = "a".repeat(32);
  process.env["AGENTROOM_DB"] = ":memory:";
  delete process.env["RATE_LIMIT_DISABLED"];
  await sodiumReady();
});

// Re-import after env is set so auth.ts initialises correctly
async function getAuth() {
  return import("./auth.js");
}

describe("rate limiter: challenge", () => {
  it("allows up to capacity requests per IP", async () => {
    const { consumeChallengeRate } = await getAuth();
    const ip = `test-${Date.now()}-challenge`;
    let allowed = 0;
    for (let i = 0; i < 15; i++) {
      if (consumeChallengeRate(ip)) allowed++;
    }
    expect(allowed).toBe(10); // capacity = 10
  });

  it("different IPs have independent buckets", async () => {
    const { consumeChallengeRate } = await getAuth();
    const ts = Date.now();
    const ip1 = `ip1-${ts}`;
    const ip2 = `ip2-${ts}`;
    let a1 = 0, a2 = 0;
    for (let i = 0; i < 12; i++) {
      if (consumeChallengeRate(ip1)) a1++;
      if (consumeChallengeRate(ip2)) a2++;
    }
    expect(a1).toBe(10);
    expect(a2).toBe(10);
  });
});

describe("rate limiter: hello fail", () => {
  it("allows up to 5 HELLO failures per IP", async () => {
    const { consumeHelloFailRate } = await getAuth();
    const ip = `test-${Date.now()}-hello`;
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (consumeHelloFailRate(ip)) allowed++;
    }
    expect(allowed).toBe(5); // capacity = 5
  });

  it("returns false once limit is exhausted", async () => {
    const { consumeHelloFailRate } = await getAuth();
    const ip = `test-${Date.now()}-exhausted`;
    for (let i = 0; i < 5; i++) consumeHelloFailRate(ip);
    expect(consumeHelloFailRate(ip)).toBe(false);
  });
});

describe("rate bucket eviction", () => {
  it("evicts idle buckets so the map stays bounded", async () => {
    const { consumeChallengeRate, runAuthMaintenance, clearRateBuckets } = await getAuth();
    clearRateBuckets(); // start from a clean slate
    const base = Date.now();
    for (let i = 0; i < 50; i++) consumeChallengeRate(`evict-${base}-${i}`);
    // Run maintenance as if 200s elapsed (> BUCKET_IDLE_TTL_MS 120s): all idle.
    runAuthMaintenance(base + 200_000);
    expect(clearRateBuckets()).toBe(0); // every idle bucket dropped
  });

  it("keeps recently-active buckets", async () => {
    const { consumeChallengeRate, runAuthMaintenance, clearRateBuckets } = await getAuth();
    clearRateBuckets();
    const base = Date.now();
    consumeChallengeRate(`fresh-${base}`);
    runAuthMaintenance(base + 1000); // only 1s elapsed: still active
    expect(clearRateBuckets()).toBe(1);
  });
});

describe("session token with jti", () => {
  it("verify returns jti field", async () => {
    const { issueSessionToken, verifySessionToken } = await getAuth();
    const token = issueSessionToken("fakepk");
    const result = verifySessionToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.jti).toBeTruthy();
      expect(result.pk).toBe("fakepk");
    }
  });

  it("expired token is rejected", async () => {
    const { issueSessionToken, verifySessionToken } = await getAuth();
    const token = issueSessionToken("fakepk");
    // maxAgeMs = -1 → always expired (age >= 0 > -1)
    const result = verifySessionToken(token, -1);
    expect(result.valid).toBe(false);
  });
});
