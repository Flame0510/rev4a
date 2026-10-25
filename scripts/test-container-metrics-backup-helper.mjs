#!/usr/bin/env node
/**
 * readContainerOverview and the cold-backup helper rows: a helper (`rev4a-backup-<agent>`) is
 * listed with is_backup while it runs and is gone once it is not running; any other stopped
 * container stays listed. In-memory database with the daemon's tables.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const ts = require('typescript');
const helper = require('../lib/backup-helper.js');

// lib/container-metrics.ts imports './backup-helper' without an extension: transpile it and
// point that at the real predicate.
globalThis.__isBackupHelperName = helper.isBackupHelperName;
const src = fs.readFileSync(new URL('../lib/container-metrics.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/from ['"]\.\/backup-helper['"]/, `from 'data:text/javascript,export const isBackupHelperName = (n) => globalThis.__isBackupHelperName(n);'`);
const { readContainerOverview } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const db = new Database(':memory:');
db.exec(`
CREATE TABLE container_metrics (ts INTEGER NOT NULL, container TEXT NOT NULL, cpu_cores REAL, mem_mb REAL, pids INTEGER,
  net_rx_bps REAL, net_tx_bps REAL, blk_read_bps REAL, blk_write_bps REAL);
CREATE TABLE container_sources (container TEXT PRIMARY KEY, agent_id TEXT, name TEXT, is_agent INTEGER NOT NULL DEFAULT 0,
  volumes TEXT, last_seen INTEGER NOT NULL);
CREATE TABLE docker_host (id INTEGER PRIMARY KEY CHECK (id = 1), ncpu INTEGER, mem_total_mb INTEGER, updated_at INTEGER);
CREATE TABLE docker_storage (ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, size_mb REAL, reclaimable_mb REAL);
CREATE TABLE system_metrics (ts INTEGER NOT NULL, cpu_percent REAL, ram_used_mb REAL);
`);
const NOW = 1_800_000_000;
const source = db.prepare('INSERT INTO container_sources (container, agent_id, name, is_agent, volumes, last_seen) VALUES (?, ?, ?, 0, \'\', ?)');
const sample = db.prepare('INSERT INTO container_metrics (ts, container, cpu_cores, mem_mb) VALUES (?, ?, 0.1, 100)');
db.prepare('INSERT INTO docker_host VALUES (1, 4, 4096, ?)').run(NOW);
// The newest sample of the daemon is at NOW; "seen 2 minutes ago" is NOW - 120.
sample.run(NOW, 'registry-live');
source.run('registry-live', null, 'registry-live', NOW);
source.run('rev4a-backup-agent_run', null, 'Backup of A (manual)', NOW - 120);
sample.run(NOW - 120, 'rev4a-backup-agent_run');
source.run('rev4a-backup-agent_old', null, 'Backup of B (before update)', NOW - 600);
sample.run(NOW - 600, 'rev4a-backup-agent_old');
source.run('registry-old', null, 'registry-old', NOW - 600);
sample.run(NOW - 600, 'registry-old');
// A helper on its first pass: Docker listed it (source row) but no sample exists yet.
source.run('rev4a-backup-agent_new', null, 'Backup of C (manual)', NOW);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

const o = readContainerOverview(db, 3600, NOW);
const by = (c) => o.containers.find((x) => x.container === c);

test('a helper seen 2 minutes ago and running is listed with is_backup', () => {
  assert.equal(by('rev4a-backup-agent_run')?.is_backup, true);
  assert.equal(by('rev4a-backup-agent_run')?.running, true);
  assert.equal(by('rev4a-backup-agent_run')?.is_agent, false);
  assert.equal(by('rev4a-backup-agent_run')?.name, 'Backup of A (manual)');
});
test('a helper seen on the latest pass without a sample yet is listed, not running', () => {
  assert.equal(by('rev4a-backup-agent_new')?.is_backup, true);
  assert.equal(by('rev4a-backup-agent_new')?.running, false);
});
test('a helper last seen 10 minutes ago (finished) is not listed', () => {
  assert.equal(by('rev4a-backup-agent_old'), undefined);
});
test('a normal stopped container last seen 10 minutes ago is still listed, is_backup false', () => {
  assert.equal(by('registry-old')?.running, false);
  assert.equal(by('registry-old')?.is_backup, false);
  assert.equal(by('registry-live')?.is_backup, false);
});
test('the rows stay in the database (nothing is deleted by the read)', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM container_sources').get().n, 5);
});

if (failed) process.exit(1);
