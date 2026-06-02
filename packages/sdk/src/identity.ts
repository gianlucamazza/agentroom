import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "fs";
import path from "path";
import {
  generateKeypair,
  toBase64,
  fromBase64,
  type AgentKeypair,
} from "@agentroom/protocol";
import { deserializeSession, serializeSession, type RatchetState } from "./session.js";

export interface StoredIdentity {
  ed25519_pk: string;
  ed25519_sk: string;
  x25519_pk: string;
  x25519_sk: string;
}

export function configBase(home?: string): string {
  return home ?? path.join(process.env["HOME"] ?? "~", ".config", "agentroom");
}

export function identityPath(home?: string): string {
  return path.join(configBase(home), "identity.json");
}

export function sessionsDir(home?: string): string {
  return path.join(configBase(home), "sessions");
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

  mkdirSync(dir, { recursive: true });
  const kp = await generateKeypair();
  const stored: StoredIdentity = {
    ed25519_pk: toBase64(kp.ed25519_pk),
    ed25519_sk: toBase64(kp.ed25519_sk),
    x25519_pk: toBase64(kp.x25519_pk),
    x25519_sk: toBase64(kp.x25519_sk),
  };
  writeFileSync(idPath, JSON.stringify(stored, null, 2), { encoding: "utf8" });
  chmodSync(idPath, 0o600);
  return { ...kp, path: idPath };
}

/** Save a single session to disk. Path: <sessionsDir>/<peerPk>.json */
export function saveSession(peerPk: string, state: RatchetState, home?: string): void {
  const dir = sessionsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${peerPk}.json`);
  writeFileSync(file, serializeSession(state), { encoding: "utf8" });
  chmodSync(file, 0o600);
}

/**
 * Load all sessions from disk and return them as an array.
 * Callers are responsible for inserting them into their own SessionStore.
 * Stale sessions (older than maxAgeDays) are pruned from disk.
 */
export function loadAllSessions(home?: string, maxAgeDays = 30): RatchetState[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];

  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const results: RatchetState[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const state = deserializeSession(readFileSync(filePath, "utf8"));
      if (state.lastUsedAt < cutoff) {
        unlinkSync(filePath);
        continue;
      }
      results.push(state);
    } catch (err) {
      const corrupt = `${filePath}.corrupt-${Date.now()}`;
      try { renameSync(filePath, corrupt); } catch { /* best-effort */ }
      console.warn(`[agentroom] corrupt session file renamed to ${path.basename(corrupt)}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
