import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { store } from "./store.js";

const CHALLENGE_TTL_MS = 60_000;
const challenges = new Map<string, number>();

// A rate bucket idle this long is safe to evict: every limiter refills to full
// capacity within 60s of inactivity, so a recreated bucket (tokens: capacity)
// is behaviorally identical to the idle one we drop. Prevents unbounded growth
// of rateBuckets (one entry per source IP) on a long-lived relay.
const BUCKET_IDLE_TTL_MS = 120_000;

/** Evict expired challenges and idle rate buckets. Exported (with injectable
 *  `now`) so tests can drive it deterministically without faking the timer. */
export function runAuthMaintenance(now = Date.now()): void {
  const challengeCutoff = now - CHALLENGE_TTL_MS;
  for (const [k, v] of challenges) {
    if (v < challengeCutoff) challenges.delete(k);
  }
  for (const [k, b] of rateBuckets) {
    if (now - b.lastRefill > BUCKET_IDLE_TTL_MS) rateBuckets.delete(k);
  }
}

// Cleanup challenges AND idle rate buckets on a fixed timer (instead of lazy-at-1000)
const challengeCleanupTimer = setInterval(() => runAuthMaintenance(), 60_000);
challengeCleanupTimer.unref?.();

export function clearChallengeInterval() {
  clearInterval(challengeCleanupTimer);
}

// ── token bucket rate limiter ──────────────────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const rateBuckets = new Map<string, Bucket>();

/** Test helper: drop all rate-limit state (and report size before clearing). */
export function clearRateBuckets(): number {
  const n = rateBuckets.size;
  rateBuckets.clear();
  return n;
}

function consumeRate(key: string, capacity: number, refillPerSec: number): boolean {
  if (process.env["RATE_LIMIT_DISABLED"] === "1") return true;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
    rateBuckets.set(key, bucket);
  } else {
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// 10 challenges per minute per IP
export function consumeChallengeRate(ip: string): boolean {
  return consumeRate(`challenge:${ip}`, 10, 10 / 60);
}

// 5 HELLO failures per minute per IP
export function consumeHelloFailRate(ip: string): boolean {
  return consumeRate(`hello_fail:${ip}`, 5, 5 / 60);
}

// ── HMAC secret ───────────────────────────────────────────────────────────

let _secret: string | null = null;
function secret(): string {
  if (!_secret) {
    const s = process.env["HMAC_SECRET"];
    if (!s || s.length < 32) {
      throw new Error(
        "HMAC_SECRET env var is missing or too short (min 32 chars). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    _secret = s;
  }
  return _secret;
}

// ── challenge ─────────────────────────────────────────────────────────────

export function issueChallenge(): string {
  const token = randomBytes(24).toString("base64url");
  challenges.set(token, Date.now());
  return token;
}

export function consumeChallenge(token: string): boolean {
  const ts = challenges.get(token);
  if (!ts) return false;
  challenges.delete(token);
  return Date.now() - ts < CHALLENGE_TTL_MS;
}

// ── session tokens ────────────────────────────────────────────────────────
// Format: base64url(jti.pk.ts) + "." + hmac

export function issueSessionToken(ed25519_pk: string): string {
  const jti = randomBytes(8).toString("base64url");
  const payload = `${jti}.${ed25519_pk}.${Date.now()}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifySessionToken(
  token: string,
  maxAgeMs = 3_600_000,
): { valid: true; pk: string; jti: string } | { valid: false } {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx < 0) return { valid: false };
    const payloadB64 = token.slice(0, dotIdx);
    const mac = token.slice(dotIdx + 1);
    if (!payloadB64 || !mac) return { valid: false };
    const payload = Buffer.from(payloadB64, "base64url").toString();
    const expectedMac = createHmac("sha256", secret()).update(payload).digest("base64url");
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) {
      return { valid: false };
    }
    const parts = payload.split(".");
    if (parts.length < 3) return { valid: false };
    const jti = parts[0]!;
    const tsStr = parts[parts.length - 1]!;
    const pk = parts.slice(1, -1).join(".");
    if (!pk || !tsStr) return { valid: false };
    if (Date.now() - parseInt(tsStr, 10) > maxAgeMs) return { valid: false };
    return { valid: true, pk, jti };
  } catch {
    return { valid: false };
  }
}
