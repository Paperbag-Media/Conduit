import { execute, queryAll, type Database } from '../sqlite';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  targetUserId?: string | null;
  profileId?: string | null;
  sessionId?: string | null;
  /** Small, non-sensitive structured context. Callers must never include secrets. */
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: number;
  occurredAt: string;
  action: string;
  outcome: AuditOutcome;
  actorUserId: string | null;
  targetUserId: string | null;
  profileId: string | null;
  sessionId: string | null;
  metadata: string;
}


export const auditRepo = {
  insert(db: Database, entry: AuditEntry, now: string): void {
    execute(
      db,
      `INSERT INTO audit_logs (occurred_at, action, outcome, actor_user_id, target_user_id, profile_id, session_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      now,
      entry.action,
      entry.outcome,
      entry.actorUserId ?? null,
      entry.targetUserId ?? null,
      entry.profileId ?? null,
      entry.sessionId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    );
  },

  /** Most recent first, only actions starting with `prefix` (e.g. "loyalty."). */
  listByPrefix(db: Database, prefix: string, limit = 50): AuditRecord[] {
    return queryAll<AuditRecord>(
      db,
      `SELECT id, occurred_at AS occurredAt, action, outcome, actor_user_id AS actorUserId,
              target_user_id AS targetUserId, profile_id AS profileId, session_id AS sessionId, metadata
         FROM audit_logs WHERE substr(action, 1, ?) = ? ORDER BY id DESC LIMIT ?`,
      prefix.length,
      prefix,
      limit,
    );
  },
};
