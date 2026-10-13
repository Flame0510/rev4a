#!/usr/bin/env node
/**
 * Tests for the intent-only switch-off (Remove on a row whose agent holds ANOTHER credential of the
 * same provider): it clears Rev4a's own setting and runs nothing in the container, because a
 * provider-wide removal would delete the other credential the agent really holds.
 *
 *   node scripts/test-credentials-intent.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Throw-away data directory: nothing here touches a real vault.
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-intent-'));
process.env.REV4A_DATA_DIR = box;
process.env.REV4A_CREDENTIALS_DB = path.join(box, 'credentials.db');

const root = pathToFileURL(import.meta.dirname + '/../').href;
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(root)};
const tryExt = (p) => { for (const e of ['.ts', '.js']) if (existsSync(p + e)) return p + e; return null; };
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const p = tryExt(new URL(specifier.slice(2), root).pathname);
    if (p) return next(pathToFileURL(p).href, context);
  } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
    const p = tryExt(new URL(specifier, context.parentURL).pathname);
    if (p) return next(pathToFileURL(p).href, context);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    const { readFileSync } = await import('node:fs');
    return { format: 'json', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true };
  }
  return next(url, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));

try {
  const vault = await import('../lib/credentials/vault.ts');
  const a = await import('../lib/credentials/assignments.ts');
  const dl = await import('../lib/credentials/delivery.ts');

  const id = vault.createProfile('trello', 'Intent test', { apiKey: 'SENTINEL_KEY_aaaaaaaaaa', token: 'SENTINEL_TOKEN_bbbbbbbbbb' });
  a.recordAssignment(id, 'agent_x', { enabled: true, mode: 'env', ok: true });

  // No docker is reachable here: if intentOnly tried any exec or any running-check it would not return ok.
  const r = await dl.disableAssignment(id, 'agent_x', { intentOnly: true });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const row = a.getAssignment(id, 'agent_x');
  assert.equal(row.enabled, false);
  assert.equal(row.pendingRemoval, false, 'no removal is left pending: nothing was to be removed');
  console.log('ok   intent-only switch-off clears the setting, runs nothing, leaves no pending removal');

  // A row with no setting at all: ok, and no row appears.
  const r2 = await dl.disableAssignment(id, 'agent_none', { intentOnly: true });
  assert.equal(r2.status, 'ok');
  assert.equal(a.getAssignment(id, 'agent_none'), null);
  console.log('ok   intent-only on an agent with no row writes nothing');

  // A pending removal has real work to do in the container: refused, row untouched.
  a.recordAssignment(id, 'agent_p', { enabled: false, pendingRemoval: true, ok: false, error: 'Removal failed: x' });
  const r3 = await dl.disableAssignment(id, 'agent_p', { intentOnly: true });
  assert.equal(r3.status, 'error');
  assert.equal(a.getAssignment(id, 'agent_p').pendingRemoval, true);
  console.log('ok   intent-only never clears a pending removal');

  // A held credential may come from outside this Rev4a. If its removal fails,
  // persist a pending row so Retry and the delete guard can find it.
  const heldState = a.removalRecordState(null, true, ['store refused']);
  assert.deepEqual(heldState, { enabled: false, pendingRemoval: true, ok: false, error: 'Removal failed: store refused' });
  a.recordAssignment(id, 'agent_held', heldState);
  const heldRow = a.getAssignment(id, 'agent_held');
  assert.equal(heldRow.enabled, false);
  assert.equal(heldRow.pendingRemoval, true);
  assert.match(heldRow.lastError, /Removal failed/);
  assert.equal(a.removalRecordState(null, true, []), null);
  console.log('ok   failed held removal creates a pending row without an earlier assignment');

  vault.markSynced(id, 'active');
  const deliveredAt = vault.getProfile(id).lastSyncedAt;
  assert.ok(deliveredAt);
  vault.markSynced(id, 'error');
  assert.equal(vault.getProfile(id).lastSyncedAt, deliveredAt);
  console.log('ok   failed delivery does not stamp last_synced_at');

  // The Gateway-not-ready message touches last_error only: a delivered row stays delivered.
  a.recordAssignment(id, 'agent_d', { enabled: true, mode: 'env', ok: true });
  const before = a.getAssignment(id, 'agent_d');
  assert.ok(before.syncedAt);
  a.setAssignmentError(id, 'agent_d', dl.GATEWAY_NOT_READY_ERROR);
  const after = a.getAssignment(id, 'agent_d');
  assert.equal(after.lastError, dl.GATEWAY_NOT_READY_ERROR);
  assert.equal(after.syncedAt, before.syncedAt, 'synced_at is kept');
  assert.equal(after.enabled, true);
  console.log('ok   the Gateway-not-ready error keeps synced_at and the enabled flag');
} finally {
  fs.rmSync(box, { recursive: true, force: true });
}
