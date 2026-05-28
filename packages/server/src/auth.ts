import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const CHALLENGE_TTL_MS = 60_000;
const challenges = new Map<string, number>();

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

export function issueChallenge(): string {
  const token = randomBytes(24).toString("base64url");
  challenges.set(token, Date.now());
  // lazy cleanup
  if (challenges.size > 1000) {
    const cutoff = Date.now() - CHALLENGE_TTL_MS;
    for (const [k, v] of challenges) {
      if (v < cutoff) challenges.delete(k);
    }
  }
  return token;
}

export function consumeChallenge(token: string): boolean {
  const ts = challenges.get(token);
  if (!ts) return false;
  challenges.delete(token);
  return Date.now() - ts < CHALLENGE_TTL_MS;
}

export function issueSessionToken(ed25519_pk: string): string {
  const payload = `${ed25519_pk}.${Date.now()}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifySessionToken(
  token: string,
  maxAgeMs = 3_600_000,
): { valid: true; pk: string } | { valid: false } {
  try {
    const [payloadB64, mac] = token.split(".");
    if (!payloadB64 || !mac) return { valid: false };
    const payload = Buffer.from(payloadB64, "base64url").toString();
    const expectedMac = createHmac("sha256", secret()).update(payload).digest("base64url");
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) {
      return { valid: false };
    }
    const [pk, tsStr] = payload.split(".");
    if (!pk || !tsStr) return { valid: false };
    if (Date.now() - parseInt(tsStr, 10) > maxAgeMs) return { valid: false };
    return { valid: true, pk };
  } catch {
    return { valid: false };
  }
}
