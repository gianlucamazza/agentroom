import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// AGENTROOM_DB=:memory: in tests
const DB_PATH = process.env["AGENTROOM_DB"] ?? path.join(DATA_DIR, "agentroom.db");

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    ed25519_pk    TEXT PRIMARY KEY,
    x25519_pk     TEXT NOT NULL,
    registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen     INTEGER
  );

  CREATE TABLE IF NOT EXISTS invites (
    invite_id   TEXT PRIMARY KEY,
    blob        TEXT NOT NULL,
    inviter_pk  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    claimed_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS pending_messages (
    id          TEXT PRIMARY KEY,
    to_pk       TEXT NOT NULL,
    envelope    TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_pending_to ON pending_messages(to_pk);
  CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites(expires_at);
`);

type AgentRow = { ed25519_pk: string; x25519_pk: string };
type InviteRow = { invite_id: string; blob: string; inviter_pk: string; expires_at: number; claimed_at: number | null };
type PendingRow = { id: string; envelope: string };

const stmts = {
  upsertAgent: db.prepare(
    `INSERT INTO agents (ed25519_pk, x25519_pk, last_seen)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(ed25519_pk) DO UPDATE SET x25519_pk=excluded.x25519_pk, last_seen=excluded.last_seen`,
  ),
  touchAgent: db.prepare(`UPDATE agents SET last_seen=unixepoch() WHERE ed25519_pk=?`),
  getAgent: db.prepare(`SELECT ed25519_pk, x25519_pk FROM agents WHERE ed25519_pk=?`),
  countAgents: db.prepare(`SELECT COUNT(*) as n FROM agents`),

  publishInvite: db.prepare(
    `INSERT OR IGNORE INTO invites (invite_id, blob, inviter_pk, expires_at)
     VALUES (?, ?, ?, ?)`,
  ),
  claimInvite: db.prepare(
    `UPDATE invites SET claimed_at=unixepoch()
     WHERE invite_id=? AND claimed_at IS NULL AND expires_at > unixepoch()`,
  ),
  getInvite: db.prepare(`SELECT * FROM invites WHERE invite_id=?`),
  countInvites: db.prepare(`SELECT COUNT(*) as n FROM invites`),

  enqueuePending: db.prepare(
    `INSERT INTO pending_messages (id, to_pk, envelope) VALUES (?, ?, ?)`,
  ),
  dequeuePending: db.prepare(
    `SELECT id, envelope FROM pending_messages WHERE to_pk=? ORDER BY created_at ASC`,
  ),
  deletePending: db.prepare(`DELETE FROM pending_messages WHERE id=?`),
  countPending: db.prepare(`SELECT COUNT(*) as n FROM pending_messages WHERE to_pk=?`),
  countAllPending: db.prepare(`SELECT COUNT(*) as n FROM pending_messages`),

  pruneExpiredInvites: db.prepare(
    `DELETE FROM invites WHERE expires_at <= unixepoch() AND claimed_at IS NULL`,
  ),
  pruneClaimedInvites: db.prepare(
    `DELETE FROM invites WHERE claimed_at IS NOT NULL AND claimed_at < ?`,
  ),
  pruneOldPending: db.prepare(
    `DELETE FROM pending_messages WHERE created_at < unixepoch() - ?`,
  ),
  pruneInactiveAgents: db.prepare(
    `DELETE FROM agents WHERE last_seen IS NOT NULL AND last_seen < unixepoch() - ?`,
  ),

};

export const store = {
  upsertAgent(ed25519_pk: string, x25519_pk: string) {
    stmts.upsertAgent.run(ed25519_pk, x25519_pk);
  },
  touchAgent(pk: string) {
    stmts.touchAgent.run(pk);
  },
  getAgent(pk: string): AgentRow | undefined {
    return stmts.getAgent.get(pk) as AgentRow | undefined;
  },
  countAgents(): number {
    return (stmts.countAgents.get() as { n: number }).n;
  },

  publishInvite(invite_id: string, blob: string, inviter_pk: string, expires_at: number) {
    stmts.publishInvite.run(invite_id, blob, inviter_pk, expires_at);
  },
  claimInvite(invite_id: string): boolean {
    const info = stmts.claimInvite.run(invite_id);
    return (info as unknown as { changes: number }).changes > 0;
  },
  getInvite(invite_id: string): InviteRow | undefined {
    return stmts.getInvite.get(invite_id) as InviteRow | undefined;
  },
  countInvites(): number {
    return (stmts.countInvites.get() as { n: number }).n;
  },

  enqueuePending(id: string, to_pk: string, envelope: string) {
    stmts.enqueuePending.run(id, to_pk, envelope);
  },
  dequeuePending(to_pk: string): PendingRow[] {
    return stmts.dequeuePending.all(to_pk) as PendingRow[];
  },
  deletePending(id: string) {
    stmts.deletePending.run(id);
  },
  countPending(to_pk: string): number {
    const row = stmts.countPending.get(to_pk) as { n: number } | undefined;
    return row?.n ?? 0;
  },
  countAllPending(): number {
    return (stmts.countAllPending.get() as { n: number }).n;
  },

  prune(ttl_days = 7) {
    stmts.pruneExpiredInvites.run();
    stmts.pruneOldPending.run(ttl_days * 86400);
    // claimed invites older than 30 days
    const claimedCutoffSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    stmts.pruneClaimedInvites.run(claimedCutoffSec);
    // agents inactive > 90 days
    stmts.pruneInactiveAgents.run(90 * 86400);
  },

  closeDb() {
    db.close();
  },
};
