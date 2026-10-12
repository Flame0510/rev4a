import { openCredentialsDb } from './db';
import { ASSIGNMENT_MODES, type AssignmentMode } from './native';

/** A stored profile → agent assignment. `agentId` is the agent's container name. */
export interface CredentialAssignment {
  profileId: string;
  agentId: string;
  enabled: boolean;
  mode: AssignmentMode;
  syncedAt: number | null;
  lastError: string | null;
  /** The switch-off failed: the token may still be on the agent. Retried at re-apply; blocks deleting the credential. */
  pendingRemoval: boolean;
}

interface Row {
  profileId: string;
  agentId: string;
  enabled: number;
  mode: string;
  syncedAt: number | null;
  lastError: string | null;
  pendingRemoval: number;
}

const SELECT = `SELECT profile_id AS profileId, agent_id AS agentId, enabled, mode,
                       synced_at AS syncedAt, last_error AS lastError,
                       pending_removal AS pendingRemoval
                FROM credential_assignments`;

function shape(r: Row): CredentialAssignment {
  return {
    profileId: r.profileId,
    agentId: r.agentId,
    enabled: r.enabled === 1,
    mode: (ASSIGNMENT_MODES as readonly string[]).includes(r.mode) ? (r.mode as AssignmentMode) : 'env',
    syncedAt: r.syncedAt,
    lastError: r.lastError,
    pendingRemoval: r.pendingRemoval === 1,
  };
}

export function listAssignments(profileId: string): CredentialAssignment[] {
  const db = openCredentialsDb(true);
  try {
    return (db.prepare(`${SELECT} WHERE profile_id = ? ORDER BY agent_id`).all(profileId) as Row[]).map(shape);
  } finally {
    db.close();
  }
}

/** Every assignment, for the agent panel and the Credentials page. */
export function listAllAssignments(): CredentialAssignment[] {
  const db = openCredentialsDb(true);
  try {
    return (db.prepare(`${SELECT} ORDER BY agent_id, profile_id`).all() as Row[]).map(shape);
  } finally {
    db.close();
  }
}

/** Assignments the agent must hold (enabled) or must still be cleaned of (pending removal). */
export function listLiveForAgent(agentId: string): CredentialAssignment[] {
  const db = openCredentialsDb(true);
  try {
    return (db.prepare(`${SELECT} WHERE agent_id = ? AND (enabled = 1 OR pending_removal = 1)`).all(agentId) as Row[]).map(shape);
  } finally {
    db.close();
  }
}


export function getAssignment(profileId: string, agentId: string): CredentialAssignment | null {
  const db = openCredentialsDb(true);
  try {
    const r = db.prepare(`${SELECT} WHERE profile_id = ? AND agent_id = ?`).get(profileId, agentId) as Row | undefined;
    return r ? shape(r) : null;
  } finally {
    db.close();
  }
}

/**
 * Record the outcome of a delivery. `lastError` is stored as text shown in the UI, so
 * callers pass a message already stripped of secret values.
 */
export function recordAssignment(
  profileId: string,
  agentId: string,
  state: { enabled: boolean; mode?: AssignmentMode; ok: boolean; error?: string | null; pendingRemoval?: boolean },
): void {
  const db = openCredentialsDb(false);
  try {
    db.prepare(
      `INSERT INTO credential_assignments (profile_id, agent_id, enabled, mode, synced_at, last_error, pending_removal)
       VALUES (@p, @a, @e, @m, @s, @err, @pend)
       ON CONFLICT(profile_id, agent_id) DO UPDATE SET
         enabled = @e, mode = @m, synced_at = @s, last_error = @err, pending_removal = @pend`,
    ).run({
      p: profileId,
      a: agentId,
      e: state.enabled ? 1 : 0,
      m: state.mode ?? 'env',
      s: state.ok ? Date.now() : null,
      err: state.ok ? null : (state.error ?? 'failed').slice(0, 500),
      pend: state.pendingRemoval ? 1 : 0,
    });
  } finally {
    db.close();
  }
}

/** Set only `last_error` on an existing row; enabled, synced_at and the pending mark stay as they are. */
export function setAssignmentError(profileId: string, agentId: string, error: string): void {
  const db = openCredentialsDb(false);
  try {
    db.prepare('UPDATE credential_assignments SET last_error = ? WHERE profile_id = ? AND agent_id = ?')
      .run(error.slice(0, 500), profileId, agentId);
  } finally {
    db.close();
  }
}

/** Switch off the other profiles of the same provider on this agent: the env names would collide. */
export function supersedeSiblings(profileId: string, providerId: string, agentId: string): string[] {
  const db = openCredentialsDb(false);
  try {
    const rows = db.prepare(
      `SELECT a.profile_id AS id FROM credential_assignments a
       JOIN credential_profiles p ON p.id = a.profile_id
       WHERE a.agent_id = ? AND (a.enabled = 1 OR a.pending_removal = 1) AND p.provider_id = ? AND a.profile_id != ?`,
    ).all(agentId, providerId, profileId) as { id: string }[];
    const stmt = db.prepare('UPDATE credential_assignments SET enabled = 0, pending_removal = 0, synced_at = NULL, last_error = NULL WHERE profile_id = ? AND agent_id = ?');
    for (const r of rows) stmt.run(r.id, agentId);
    return rows.map((r) => r.id);
  } finally {
    db.close();
  }
}

export function deleteAssignments(profileId: string): void {
  const db = openCredentialsDb(false);
  try {
    db.prepare('DELETE FROM credential_assignments WHERE profile_id = ?').run(profileId);
  } finally {
    db.close();
  }
}

/** Drop every assignment of an agent (it was deleted): nothing remains to switch off. */
export function deleteAssignmentsForAgent(...agentIds: string[]): number {
  const ids = [...new Set(agentIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const db = openCredentialsDb(false);
  try {
    const stmt = db.prepare('DELETE FROM credential_assignments WHERE agent_id = ?');
    return ids.reduce((n, id) => n + stmt.run(id).changes, 0);
  } finally {
    db.close();
  }
}

/** Drop one row ("Forget", for an agent that no longer exists). */
export function deleteAssignment(profileId: string, agentId: string): void {
  const db = openCredentialsDb(false);
  try {
    db.prepare('DELETE FROM credential_assignments WHERE profile_id = ? AND agent_id = ?').run(profileId, agentId);
  } finally {
    db.close();
  }
}

export function parseMode(value: unknown): AssignmentMode | null {
  return (ASSIGNMENT_MODES as readonly string[]).includes(value as string) ? (value as AssignmentMode) : null;
}

