import Database from 'better-sqlite3';
import { openCredentialsDb as openDb } from './db';
import { getProvider } from './providers';

export interface CredentialProfile {
  id: string;
  providerId: string;
  label: string;
  status: 'active' | 'error';
  secretMasked: string | null;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt: number | null;
}

export type CredentialSecret = Record<string, string>;

function mask(value: string): string {
  if (!value) return '••••••••';
  if (value.length <= 8) return '•'.repeat(value.length);
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

/**
 * Find the first password field in a provider to use for masked display.
 * Falls back to the first field if no password field exists.
 */
function firstPasswordField(provider: { fields: { key: string; type: string }[] }): string | undefined {
  const pwField = provider.fields.find((f) => f.type === 'password');
  return pwField?.key ?? provider.fields[0]?.key;
}

export function appendAudit(db: Database.Database, action: string, profileId: string, result: string): void {
  try {
    db.prepare(
      'INSERT INTO credential_audit_log (ts, actor, action, profile_id, result) VALUES (?, ?, ?, ?, ?)',
    ).run(Date.now(), 'system', action, profileId, result);
  } catch {
    // Audit failures are non-fatal
  }
}

export function listProfiles(): CredentialProfile[] {
  const db = openDb(true);
  try {
    return db.prepare(
      `SELECT id, provider_id AS providerId, label, status,
              secret_masked AS secretMasked, created_at AS createdAt,
              updated_at AS updatedAt, last_synced_at AS lastSyncedAt
       FROM credential_profiles ORDER BY created_at DESC`,
    ).all() as CredentialProfile[];
  } finally {
    db.close();
  }
}

export function getProfile(id: string): CredentialProfile | null {
  const db = openDb(true);
  try {
    return db.prepare(
      `SELECT id, provider_id AS providerId, label, status,
              secret_masked AS secretMasked, created_at AS createdAt,
              updated_at AS updatedAt, last_synced_at AS lastSyncedAt
       FROM credential_profiles WHERE id = ?`,
    ).get(id) as CredentialProfile | null;
  } finally {
    db.close();
  }
}

export function getSecret(profileId: string): CredentialSecret {
  const db = openDb(true);
  try {
    const row = db.prepare(
      'SELECT payload FROM credential_secrets WHERE profile_id = ?',
    ).get(profileId) as { payload: string } | null;
    if (!row) return {};
    return JSON.parse(row.payload) as CredentialSecret;
  } finally {
    db.close();
  }
}

export function createProfile(
  providerId: string,
  label: string,
  secret: CredentialSecret,
): string {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const id = `cred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const maskKey = firstPasswordField(provider);
  const secretMasked = mask(maskKey ? (secret[maskKey] ?? '') : '');
  const payload = JSON.stringify(secret);

  const db = openDb(false);
  try {
    db.prepare(
      `INSERT INTO credential_profiles
         (id, provider_id, label, status, secret_masked, created_at, updated_at, last_synced_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)`,
    ).run(id, providerId, label, secretMasked, now, now);

    db.prepare(
      'INSERT INTO credential_secrets (profile_id, payload) VALUES (?, ?)',
    ).run(id, payload);

    appendAudit(db, 'create', id, 'ok');
    return id;
  } finally {
    db.close();
  }
}

export function updateProfile(
  id: string,
  label: string,
  secret: CredentialSecret,
): void {
  const profile = getProfile(id);
  if (!profile) throw new Error(`Profile not found: ${id}`);

  const now = Date.now();
  const db = openDb(false);
  try {
    // Only the fields the form actually filled in. The edit modal opens with
    // every secret input blank — it never prefills a stored secret — so a blank
    // field means "leave this one alone", not "clear it".
    const provided = Object.entries(secret)
      .filter(([, v]) => v && v.trim().length > 0)
      .reduce<CredentialSecret>((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    if (Object.keys(provided).length > 0) {
      const provider = getProvider(profile.providerId);
      if (!provider) throw new Error(`Unknown provider: ${profile.providerId}`);

      const row = db.prepare(
        'SELECT payload FROM credential_secrets WHERE profile_id = ?',
      ).get(id) as { payload: string } | undefined;

      let existing: CredentialSecret = {};
      try {
        existing = row ? (JSON.parse(row.payload) as CredentialSecret) : {};
      } catch {
        existing = {};
      }

      // Merged onto what is stored, not substituted for it. Rotating only the
      // Trello `token` used to write a payload holding that one field, dropping
      // `apiKey` — and every later sync then failed with "Missing Trello API key
      // or token". Trello is the only two-field provider, and the move to the
      // REST endpoint made both fields load-bearing.
      const merged: CredentialSecret = { ...existing, ...provided };
      const payload = JSON.stringify(merged);
      const secretChanged = payload !== (row?.payload ?? '');

      const maskKey = firstPasswordField(provider);
      const secretMasked = mask(maskKey ? (merged[maskKey] ?? '') : '');

      db.prepare(
        secretChanged
          // A stored secret the agents no longer hold has not been delivered, so
          // the row must stop reading "synced 2d ago" the moment it changes.
          // detect flags those same agents ◆ on its next pass.
          ? 'UPDATE credential_profiles SET label = ?, secret_masked = ?, updated_at = ?, last_synced_at = NULL WHERE id = ?'
          : 'UPDATE credential_profiles SET label = ?, secret_masked = ?, updated_at = ? WHERE id = ?',
      ).run(label, secretMasked, now, id);

      db.prepare(
        'UPDATE credential_secrets SET payload = ? WHERE profile_id = ?',
      ).run(payload, id);
    } else {
      // Only update label, keep existing secret and secret_masked
      db.prepare(
        'UPDATE credential_profiles SET label = ?, updated_at = ? WHERE id = ?',
      ).run(label, now, id);
    }

    appendAudit(db, 'update', id, 'ok');
  } finally {
    db.close();
  }
}

export function deleteProfile(id: string): void {
  const db = openDb(false);
  try {
    db.prepare('DELETE FROM credential_secrets WHERE profile_id = ?').run(id);
    db.prepare('DELETE FROM credential_profiles WHERE id = ?').run(id);
    appendAudit(db, 'delete', id, 'ok');
  } finally {
    db.close();
  }
}

/**
 * Record that a credential was removed from one container.
 *
 * `last_synced_at` is deliberately left alone: it means "when this credential
 * was last delivered", and a removal is not a delivery. The de-sync path used
 * to call markSynced(), which stamped the removal as a fresh sync — so the row
 * went on showing a green dot and "synced just now" at the exact moment the
 * credential stopped being there.
 *
 * `status` stays 'active' because de-sync targets a single container: with
 * several agents the credential is still delivered to the others.
 */
export function markDesynced(id: string): void {
  const db = openDb(false);
  try {
    db.prepare(
      "UPDATE credential_profiles SET status = 'active', updated_at = ? WHERE id = ?",
    ).run(Date.now(), id);
    appendAudit(db, 'desync', id, 'ok');
  } finally {
    db.close();
  }
}

export function markSynced(id: string, status: 'active' | 'error'): void {
  const db = openDb(false);
  try {
    const now = Date.now();
    if (status === 'active') {
      db.prepare(
        'UPDATE credential_profiles SET last_synced_at = ?, status = ?, updated_at = ? WHERE id = ?',
      ).run(now, status, now, id);
    } else {
      db.prepare(
        'UPDATE credential_profiles SET status = ?, updated_at = ? WHERE id = ?',
      ).run(status, now, id);
    }
    appendAudit(db, 'sync', id, status);
  } finally {
    db.close();
  }
}

/**
 * Reveal a secret payload and log the access in the audit trail.
 * Use sparingly — every call is logged.
 */
export function revealSecret(profileId: string): CredentialSecret {
  const secret = getSecret(profileId);

  // The audit handle must be writable: this used to open the database readonly
  // and then INSERT through it, so SQLite rejected every write, appendAudit
  // swallowed the error by design, and not one reveal was ever recorded.
  //
  // Wrapped because a writable open does more than the readonly one it replaced
  // — it also runs migrateV1(), whose DDL has a `finally` but no `catch`, so a
  // failure there propagates. An audit trail must never be able to break the
  // operation it records: losing one log line beats refusing to return a secret
  // the caller is entitled to.
  try {
    const db = openDb(false);
    try {
      appendAudit(db, 'reveal', profileId, 'ok');
    } finally {
      db.close();
    }
  } catch { /* audit unavailable; the reveal itself still stands */ }

  return secret;
}
