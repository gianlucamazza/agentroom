import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import path from "path";
import {
  generateKeypair,
  toBase64,
  fromBase64,
  type AgentKeypair,
} from "@agentroom/protocol";

export interface StoredIdentity {
  ed25519_pk: string;
  ed25519_sk: string;
  x25519_pk: string;
  x25519_sk: string;
}

export function identityPath(home?: string): string {
  const base = home ?? path.join(process.env["HOME"] ?? "~", ".config", "agentroom");
  return path.join(base, "identity.json");
}

export async function loadOrCreateIdentity(home?: string): Promise<AgentKeypair & { path: string }> {
  const idPath = identityPath(home);
  const dir = path.dirname(idPath);

  if (existsSync(idPath)) {
    const raw = JSON.parse(readFileSync(idPath, "utf8")) as StoredIdentity;
    return {
      ed25519_pk: fromBase64(raw.ed25519_pk),
      ed25519_sk: fromBase64(raw.ed25519_sk),
      x25519_pk: fromBase64(raw.x25519_pk),
      x25519_sk: fromBase64(raw.x25519_sk),
      path: idPath,
    };
  }

  // First run: generate and persist
  mkdirSync(dir, { recursive: true });
  const kp = await generateKeypair();
  const stored: StoredIdentity = {
    ed25519_pk: toBase64(kp.ed25519_pk),
    ed25519_sk: toBase64(kp.ed25519_sk),
    x25519_pk: toBase64(kp.x25519_pk),
    x25519_sk: toBase64(kp.x25519_sk),
  };
  writeFileSync(idPath, JSON.stringify(stored, null, 2), { encoding: "utf8" });
  // private key file — owner-read only
  chmodSync(idPath, 0o600);
  return { ...kp, path: idPath };
}
