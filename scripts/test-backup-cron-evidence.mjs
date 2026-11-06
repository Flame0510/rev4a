#!/usr/bin/env node
/** Source-archive provenance checks for cron repair. Local temp files and mocked inspection only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(root)};
export async function resolve(name, context, next) {
  const base = name.startsWith('@/') ? root + '/' + name.slice(2)
    : name.startsWith('.') && context.parentURL?.startsWith('file:') ? new URL(name, context.parentURL).pathname : null;
  if (base && !/\\.[a-z]+$/.test(base)) for (const ext of ['.ts', '.js']) {
    if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
  }
  return next(name, context);
}
export async function load(url, context, next) {
  return next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);
}`), pathToFileURL(root + '/'));
const { createPreUpdateCronEvidenceReader } = await import('../lib/backup-cron-evidence.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-cron-evidence-'));
const file = 'agent-agent_fixture-preupdate-2026.9.9-2026-11-06_120000001.tar.gz';
const input = { agentId: 'agent_fixture', backupFile: file, fromVersion: '2026.9.9', toVersion: '2026.10.10', baselineJson: JSON.stringify({ transcripts: {}, cronJobs: [] }) };
const archive = { sha256: 'a'.repeat(64), configVersion: '2026.9.9', stateSchemaVersion: 19,
  agentSchemaVersions: { main: 24 }, cronJobs: [{ id: 'owned', name: 'review', declarationKey: 'skill-collection-review:main', agentId: 'main' }], cronEvidenceComplete: true };
fs.writeFileSync(path.join(dir, file), 'inspection fixture');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }
const reader = (changes = {}) => createPreUpdateCronEvidenceReader({ backupsDir: dir, inspect: async () => ({ ...archive, ...changes }) });
try {
  await test('matching source config, schemas and complete identities establish bounded provenance', async () => {
    const result = await reader()(input);
    assert.equal(result.kind, 'verified');
    assert.equal(result.file, file);
    assert.equal(result.sha256, archive.sha256);
    assert.deepEqual(result.jobs, archive.cronJobs);
  });
  await test('wrong agent, non-preupdate name, label mismatch, unknown transition and invalid baseline never invoke inspection', async () => {
    let calls = 0;
    const read = createPreUpdateCronEvidenceReader({ backupsDir: dir, inspect: async () => { calls++; return archive; } });
    for (const change of [{ agentId: 'other' }, { backupFile: file.replace('preupdate-2026.9.9', 'cold') },
      { fromVersion: '2026.9.3' }, { toVersion: '2026.10.11' }, { baselineJson: '{}' }, { backupFile: '../' + file }]) {
      assert.equal((await read({ ...input, ...change })).kind, 'unavailable');
    }
    assert.equal(calls, 0);
  });
  await test('filename alone cannot certify stale metadata, future/mixed schema or incomplete ownership', async () => {
    for (const change of [{ configVersion: null }, { configVersion: '2026.10.10' }, { stateSchemaVersion: 22 },
      { agentSchemaVersions: { main: 24, other: 27 } }, { cronEvidenceComplete: false },
      { cronJobs: [{ id: 'same' }, { id: 'same' }] }, { sha256: 'not-a-digest' }]) {
      assert.equal((await reader(change)(input)).kind, 'unavailable');
    }
  });
  await test('symlink and directory sources cannot reach the inspector', async () => {
    const link = file.replace('120000001', '120000002');
    fs.symlinkSync(path.join(dir, file), path.join(dir, link));
    const folder = file.replace('120000001', '120000003');
    fs.mkdirSync(path.join(dir, folder));
    let calls = 0;
    const read = createPreUpdateCronEvidenceReader({ backupsDir: dir, inspect: async () => { calls++; return archive; } });
    for (const backupFile of [link, folder, file.replace('120000001', '120000004')]) {
      assert.equal((await read({ ...input, backupFile })).kind, 'unavailable');
    }
    assert.equal(calls, 0);
  });
  await test('inspection errors retain failure safely without leaking native error text', async () => {
    const read = createPreUpdateCronEvidenceReader({ backupsDir: dir, inspect: async () => { throw new Error('private-token-value /private/source'); } });
    const result = await read(input);
    assert.equal(result.kind, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /private-token-value|\/private\/source/);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} passed`);
