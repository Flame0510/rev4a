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
    // Only update secret fields if at least one field has a non-empty value
    const hasValues = Object.values(secret).some((v) => v && v.trim().length > 0);

    if (hasValues) {
      const provider = getProvider(profile.providerId);
      if (!provider) throw new Error(`Unknown provider: ${profile.providerId}`);

      const maskKey = firstPasswordField(provider);
      const secretMasked = mask(maskKey ? (secret[maskKey] ?? '') : '');
      const payload = JSON.stringify(secret);

      db.prepare(
        'UPDATE credential_profiles SET label = ?, secret_masked = ?, updated_at = ? WHERE id = ?',
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

export function markSynced(id: string, status: 'active' | 'error'): void {
  const db = openDb(false);
  try {
    db.prepare(
      'UPDATE credential_profiles SET last_synced_at = ?, status = ?, updated_at = ? WHERE id = ?',
    ).run(Date.now(), status, Date.now(), id);
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
  const db = openDb(true);
  try {
    const secret = getSecret(profileId);
    appendAudit(db, 'reveal', profileId, 'ok');
    return secret;
  } finally {
    db.close();
  }
}
