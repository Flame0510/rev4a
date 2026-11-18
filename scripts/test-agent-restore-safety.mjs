#!/usr/bin/env node
/** Host-only archive/restore safety tests. All files and SQLite databases are disposable fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { inspectBackupArchive, BackupInspectionError } from '../lib/backup-inspection.ts';
import { checkBackupCompatibility, verifiedBackupSchemasFor } from '../lib/backup-compatibility.ts';
import { inspectBackupDatabases } from '../lib/backup-sqlite-worker.js';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rev4a-restore-tests-'));
const require = createRequire(import.meta.url);
let count = 0; let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error}`); process.exitCode = 1; throw error; }
}
const config = version => Buffer.from(JSON.stringify(version ? { meta: { lastTouchedVersion: version } } : {}));
function header(name, size = 0, type = '0', link = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.fill(32, 148, 156); h.write(type, 156); h.write(link, 157, 100); h.write('ustar\0', 257); h.write('00', 263);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function archive(entries, tail = true) {
  const pieces = [];
  for (const row of entries) {
    const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body ?? '');
    pieces.push(header(row.name, body.length, row.type, row.link), body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  if (tail) pieces.push(Buffer.alloc(1024));
  const file = path.join(dir, `archive-${++count}.tar.gz`);
  fs.writeFileSync(file, gzipSync(Buffer.concat(pieces)));
  return file;
}
function pax(key, value) {
  const content = `${key}=${value}\n`; let size = Buffer.byteLength(content) + 2;
  while (true) { const full = `${size} ${content}`; if (Buffer.byteLength(full) === size) return full; size = Buffer.byteLength(full); }
}
function database(schema, jobs = []) {
  const file = path.join(dir, `db-${++count}.sqlite`);
  const db = new Database(file);
  db.pragma(`user_version=${schema}`);
  db.exec('CREATE TABLE cron_jobs (job_json TEXT NOT NULL)');
  for (const job of jobs) db.prepare('INSERT INTO cron_jobs VALUES (?)').run(JSON.stringify(job));
  db.close(); return fs.readFileSync(file);
}
function content(version = '2026.9.9', state = 19, agent = 24) {
  return [
    { name: '.openclaw/openclaw.json', body: config(version) },
    { name: '.openclaw/state/openclaw.sqlite', body: database(state, [{ id: 'owned', name: 'review', declarationKey: 'skill-collection-review:main', agentId: 'main', payload: { message: 'private fixture prompt must not escape' } }]) },
    { name: '.openclaw/agents/main/agent/openclaw-agent.sqlite', body: database(agent) },
  ];
}
function withWal(callback) {
  const file = path.join(dir, `wal-case-${++count}.sqlite`); const db = new Database(file);
  try {
    db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
    db.exec('CREATE TABLE cron_jobs(job_json TEXT NOT NULL)'); db.pragma('user_version=19'); db.pragma('wal_checkpoint(TRUNCATE)');
    return callback(db, file);
  } finally { db.close(); }
}
function walBackup(main, wal) {
  return archive([{ name: '.openclaw/openclaw.json', body: config('2026.9.9') },
    { name: '.openclaw/state/openclaw.sqlite', body: main }, { name: '.openclaw/state/openclaw.sqlite-wal', body: wal }]);
}
function walSum(buffer, seed, little) {
  let [a, b] = seed;
  for (let at = 0; at < buffer.length; at += 8) {
    a = (a + (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at)) + b) >>> 0;
    b = (b + (little ? buffer.readUInt32LE(at + 4) : buffer.readUInt32BE(at + 4)) + a) >>> 0;
  }
  return [a, b];
}

try {
  await test('real system tar with SQLite yields version/schema/cron identities and full archive hash', async () => {
    const root = path.join(dir, `real-${++count}`); fs.mkdirSync(root);
    for (const row of content()) { const file = path.join(root, row.name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.body); }
    const file = path.join(dir, `real-${count}.tar.gz`);
    execFileSync('tar', ['--format=ustar', '-czf', file, '-C', root, '.']);
    const result = await inspectBackupArchive(file);
    assert.equal(result.configVersion, '2026.9.9'); assert.equal(result.stateSchemaVersion, 19); assert.deepEqual(result.agentSchemaVersions, { main: 24 });
    assert.equal(result.cronEvidenceComplete, true);
    assert.deepEqual(result.cronJobs, [{ id: 'owned', name: 'review', declarationKey: 'skill-collection-review:main', agentId: 'main' }]);
    assert.ok(!JSON.stringify(result).includes('private fixture prompt'));
    assert.equal(result.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  });
  await test('actual WAL contains the newer schema and cron evidence', async () => {
    const file = path.join(dir, `wal-${++count}.sqlite`); const db = new Database(file);
    try {
      db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
      db.exec('CREATE TABLE cron_jobs (job_json TEXT NOT NULL)'); db.pragma('user_version=22');
      db.prepare('INSERT INTO cron_jobs VALUES (?)').run(JSON.stringify({ id: 'from-wal', name: 'WAL job', agentId: 'main' }));
      const backup = archive([
        { name: '.openclaw/openclaw.json', body: config('2026.10.10') },
        // Exercise WAL-first order too.
        { name: '.openclaw/state/openclaw.sqlite-wal', body: fs.readFileSync(file + '-wal') },
        { name: '.openclaw/state/openclaw.sqlite', body: fs.readFileSync(file) },
      ]);
      const result = await inspectBackupArchive(backup);
      assert.equal(result.stateSchemaVersion, 22); assert.equal(result.cronJobs[0].id, 'from-wal'); assert.equal(result.cronEvidenceComplete, true);
    } finally { db.close(); }
  });
  await test('known legacy schema facts allow upward restore without new metadata', async () => {
    const result = await inspectBackupArchive(archive(content(null, 16, 19)));
    assert.equal(result.configVersion, null);
    assert.deepEqual(checkBackupCompatibility(result, '2026.10.10'), { compatible: true, sourceVersion: '2026.9.3', reason: null });
  });
  await test('TO content is refused on FROM regardless of filename or stale config version', async () => {
    for (const version of ['2026.10.10', '2026.9.9', null]) {
      const result = await inspectBackupArchive(archive(content(version, 22, 27)));
      assert.equal(checkBackupCompatibility(result, '2026.9.9').compatible, false);
    }
  });
  await test('config version prevents a downgrade even when core schemas look old', async () => {
    const result = await inspectBackupArchive(archive(content('2026.10.10', 19, 24)));
    assert.equal(checkBackupCompatibility(result, '2026.9.9').compatible, false);
  });
  await test('same and upward known versions pass; unknown target or missing archive facts refuse', async () => {
    const result = await inspectBackupArchive(archive(content()));
    assert.equal(checkBackupCompatibility(result, '2026.9.9').compatible, true);
    assert.equal(checkBackupCompatibility(result, '2026.10.10').compatible, true);
    assert.equal(checkBackupCompatibility(result, '2026.10.99').compatible, false);
    const empty = await inspectBackupArchive(archive([{ name: '.openclaw/openclaw.json', body: config(null) }]));
    assert.equal(checkBackupCompatibility(empty, '2026.10.10').compatible, false);
  });
  await test('unknown legacy schema is an actionable refusal', async () => {
    const result = await inspectBackupArchive(archive(content(null, 15, 18)));
    const compatibility = checkBackupCompatibility(result, '2026.10.10');
    assert.equal(compatibility.compatible, false); assert.match(compatibility.reason, /original OpenClaw/);
  });
  await test('prototype-like version and agent names cannot bypass schema safety', async () => {
    assert.equal(verifiedBackupSchemasFor('__proto__'), null); assert.equal(verifiedBackupSchemasFor('constructor'), null);
    const rows = content('2026.9.9', 19, 27); rows[2].name = '.openclaw/agents/__proto__/agent/openclaw-agent.sqlite';
    const result = await inspectBackupArchive(archive(rows));
    assert.equal(Object.hasOwn(result.agentSchemaVersions, '__proto__'), true);
    assert.equal(result.agentSchemaVersions.__proto__, 27);
    assert.equal(checkBackupCompatibility(result, '2026.9.9').compatible, false);
  });
  await test('duplicate normalized paths, traversals and absolute members refuse', async () => {
    for (const rows of [
      [{ name: '../outside', body: 'x' }], [{ name: '/outside', body: 'x' }],
      [{ name: './.openclaw/openclaw.json', body: config() }, { name: '.openclaw/openclaw.json', body: config() }],
    ]) await assert.rejects(inspectBackupArchive(archive(rows)), /traversal|unsafe|duplicate/);
  });
  await test('selected links and members beneath links refuse without following them', async () => {
    await assert.rejects(inspectBackupArchive(archive([{ name: '.openclaw/openclaw.json', type: '2', link: '/outside' }])), /regular/);
    for (const rows of [
      [{ name: '.openclaw', type: '2', link: '/outside' }, { name: '.openclaw/openclaw.json', body: config() }],
      [{ name: '.openclaw/openclaw.json', body: config() }, { name: '.openclaw', type: '2', link: '/outside' }],
    ]) await assert.rejects(inspectBackupArchive(archive(rows)), /beneath a link/);
  });
  await test('unrelated standalone npm symlinks do not blanket-refuse old backups', async () => {
    const file = archive([...content(), { name: '.openclaw/npm/node_modules/example', type: '2', link: '../.store/example' }]);
    assert.equal((await inspectBackupArchive(file)).stateSchemaVersion, 19);
  });
  await test('PAX canonical path is honored and unsafe path override rejected', async () => {
    const file = archive([{ name: 'PaxHeader', type: 'x', body: pax('path', '.openclaw/openclaw.json') }, { name: 'short', body: config('2026.9.9') }]);
    assert.equal((await inspectBackupArchive(file)).configVersion, '2026.9.9');
    await assert.rejects(inspectBackupArchive(archive([{ name: 'PaxHeader', type: 'x', body: pax('path', '../outside') }, { name: 'short', body: 'x' }])), /traversal/);
  });
  await test('GNU longname is honored; sparse and conflicting PAX metadata refuse', async () => {
    const file = archive([{ name: '././@LongLink', type: 'L', body: '.openclaw/openclaw.json\0' }, { name: 'short', body: config('2026.9.9') }]);
    assert.equal((await inspectBackupArchive(file)).configVersion, '2026.9.9');
    await assert.rejects(inspectBackupArchive(archive([{ name: 'PaxHeader', type: 'x', body: pax('GNU.sparse.size', '3') }, { name: 'short', body: 'x' }])), /unsupported PAX/);
  });
  await test('corrupt gzip, gzip-valid truncated tar and invalid checksum refuse', async () => {
    const file = archive(content()); const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, bytes.subarray(0, -8)); await assert.rejects(inspectBackupArchive(file), /gzip\/tar/);
    await assert.rejects(inspectBackupArchive(archive(content(), false)), /truncated/);
    const broken = header('.openclaw/openclaw.json', 400); broken[1] ^= 1;
    const bad = path.join(dir, `checksum-${++count}.tar.gz`); fs.writeFileSync(bad, gzipSync(Buffer.concat([broken, Buffer.alloc(1024)])));
    await assert.rejects(inspectBackupArchive(bad), /checksum/);
  });
  await test('malformed config/database and orphan WAL cannot pass inspection', async () => {
    for (const rows of [
      [{ name: '.openclaw/openclaw.json', body: '{broken' }],
      [{ name: '.openclaw/openclaw.json', body: config() }, { name: '.openclaw/state/openclaw.sqlite', body: 'not sqlite' }],
      [{ name: '.openclaw/openclaw.json', body: config() }, { name: '.openclaw/state/openclaw.sqlite-wal', body: 'orphan' }],
    ]) await assert.rejects(inspectBackupArchive(archive(rows)), /JSON|database|WAL/);
  });
  await test('member, compressed, expansion, selection and count budgets all refuse safely', async () => {
    for (const limits of [{ maxArchiveBytes: 1 }, { maxExpandedBytes: 100 }, { maxSelectedBytes: 10 }, { maxMemberBytes: 10 }, { maxMembers: 1 }]) {
      await assert.rejects(inspectBackupArchive(archive(content()), limits), /budget|too many/);
    }
  });
  await test('archive symlink is not followed', async () => {
    const file = archive(content()); const link = path.join(dir, 'archive-link.tar.gz'); fs.symlinkSync(file, link);
    await assert.rejects(inspectBackupArchive(link), /regular file/);
  });
  await test('malformed cron JSON never supplies partial repair evidence', async () => {
    const file = path.join(dir, `bad-cron-${++count}.sqlite`); const db = new Database(file);
    db.pragma('user_version=19'); db.exec("CREATE TABLE cron_jobs(job_json TEXT); INSERT INTO cron_jobs VALUES ('{broken')"); db.close();
    const result = await inspectBackupArchive(archive([{ name: '.openclaw/openclaw.json', body: config() }, { name: '.openclaw/state/openclaw.sqlite', body: fs.readFileSync(file) }]));
    assert.equal(result.cronEvidenceComplete, false); assert.deepEqual(result.cronJobs, []);
  });
  await test('corrupt non-header SQLite pages cannot pass a user_version-only inspection', async () => {
    const rows = content(); const damaged = Buffer.from(rows[2].body);
    const size = damaged.readUInt16BE(16); damaged[size] = 255; rows[2].body = damaged;
    await assert.rejects(inspectBackupArchive(archive(rows)), /integrity/);
  });
  await test('invalid, truncated and corrupt-current-generation WAL files cannot be silently ignored', async () => {
    const files = withWal((db, file) => {
      db.pragma('user_version=22');
      const main = fs.readFileSync(file); const good = fs.readFileSync(file + '-wal');
      const corrupt = Buffer.from(good); corrupt[corrupt.length - 1] ^= 1;
      const badSalt = Buffer.from(good); badSalt.writeUInt32BE((badSalt.readUInt32BE(44) ^ 1) >>> 0, 44);
      return [Buffer.from('invalid literal WAL'), good.subarray(0, good.length - 1), corrupt, badSalt].map(wal => walBackup(main, wal));
    });
    for (const file of files) await assert.rejects(inspectBackupArchive(file), /integrity/);
  });
  await test('legitimate empty and header-only WAL files preserve checkpointed facts', async () => {
    const files = withWal((db, file) => {
      const main = fs.readFileSync(file); const empty = fs.readFileSync(file + '-wal'); assert.equal(empty.length, 0);
      db.pragma('user_version=22'); const headerOnly = fs.readFileSync(file + '-wal').subarray(0, 32);
      return [walBackup(main, empty), walBackup(main, headerOnly)];
    });
    for (const file of files) assert.equal((await inspectBackupArchive(file)).stateSchemaVersion, 19);
  });
  await test('complete checksummed uncommitted WAL tail does not invent committed schema changes', async () => {
    const file = withWal((db, file) => {
      const main = fs.readFileSync(file); db.pragma('user_version=22'); const wal = Buffer.from(fs.readFileSync(file + '-wal'));
      const pageSize = wal.readUInt32BE(8); assert.equal(wal.length, 32 + 24 + pageSize);
      wal.writeUInt32BE(0, 36); // No commit marker for the valid frame.
      const little = wal.readUInt32BE(0) === 0x377f0682;
      let sum = walSum(wal.subarray(32, 40), [wal.readUInt32BE(24), wal.readUInt32BE(28)], little);
      sum = walSum(wal.subarray(56), sum, little); wal.writeUInt32BE(sum[0], 48); wal.writeUInt32BE(sum[1], 52);
      return walBackup(main, wal);
    });
    assert.equal((await inspectBackupArchive(file)).stateSchemaVersion, 19);
  });
  await test('real RESTART checkpoint with retained old-generation frames remains inspectable', async () => {
    const file = withWal((db, file) => {
      for (let i = 0; i < 10; i++) db.prepare('INSERT INTO cron_jobs VALUES (?)').run(JSON.stringify({ id: `job-${i}`, agentId: 'main' }));
      const oldSize = fs.statSync(file + '-wal').size; db.pragma('wal_checkpoint(RESTART)'); db.pragma('user_version=22');
      const wal = fs.readFileSync(file + '-wal'); assert.equal(wal.length, oldSize);
      assert.notEqual(wal.readUInt32BE(16), wal.readUInt32BE(32 + 24 + wal.readUInt32BE(8) + 8));
      return walBackup(fs.readFileSync(file), wal);
    });
    const result = await inspectBackupArchive(file); assert.equal(result.stateSchemaVersion, 22); assert.equal(result.cronJobs.length, 10);
    assert.equal(result.cronEvidenceComplete, true); assert.equal(result.cronJobs[0].name, null);
  });
  await test('an impossible committed page count is rejected even with valid frame checksums', async () => {
    const file = withWal((db, file) => {
      const main = fs.readFileSync(file); db.pragma('user_version=22'); const wal = Buffer.from(fs.readFileSync(file + '-wal'));
      wal.writeUInt32BE(1000000, 36);
      const little = wal.readUInt32BE(0) === 0x377f0682;
      let sum = walSum(wal.subarray(32, 40), [wal.readUInt32BE(24), wal.readUInt32BE(28)], little);
      sum = walSum(wal.subarray(56), sum, little); wal.writeUInt32BE(sum[0], 48); wal.writeUInt32BE(sum[1], 52);
      return walBackup(main, wal);
    });
    await assert.rejects(inspectBackupArchive(file), /integrity/);
  });
  await test('native SQLite inspection has a kill deadline and leaves the parent event loop responsive', async () => {
    const file = path.join(dir, `timeout-${++count}.sqlite`); fs.writeFileSync(file, database(19));
    await assert.rejects(inspectBackupDatabases([{ member: '.openclaw/state/openclaw.sqlite', file }], 1), /timed out/);
    let ticked = false; const read = inspectBackupDatabases([{ member: '.openclaw/state/openclaw.sqlite', file }], 2000);
    await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); })); assert.equal(ticked, true);
    assert.equal((await read).stateSchemaVersion, 19);
  });
  await test('bundled numeric require.resolve cannot replace the subprocess native module path', async () => {
    const file = path.join(dir, `bundled-${++count}.sqlite`); fs.writeFileSync(file, database(22));
    const module = { exports: {} }; let calls = 0; let bundledResolves = 0;
    const actualExecFile = require('node:child_process').execFile;
    const bundledRequire = spec => spec === 'node:child_process' ? {
      execFile(executable, args, options, callback) {
        const input = JSON.parse(args[2]);
        assert.equal(typeof input.sqliteModule, 'string'); assert.equal(path.isAbsolute(input.sqliteModule), true);
        assert.equal(input.sqliteModule, createRequire(path.join(process.cwd(), 'package.json')).resolve('better-sqlite3'));
        calls++; return actualExecFile(executable, args, options, callback);
      },
    } : require(spec);
    bundledRequire.resolve = () => { bundledResolves++; return 85148; };
    vm.runInNewContext(fs.readFileSync(new URL('../lib/backup-sqlite-worker.js', import.meta.url), 'utf8'), {
      require: bundledRequire, module, exports: module.exports, process,
    });
    const result = await module.exports.inspectBackupDatabases([{ member: '.openclaw/state/openclaw.sqlite', file }], 2000);
    assert.equal(result.stateSchemaVersion, 22); assert.equal(result.cronEvidenceComplete, true);
    assert.equal(calls, 1); assert.equal(bundledResolves, 0);
  });

  const restoreSource = fs.readFileSync(new URL('../lib/agent-restore.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(restoreSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  async function waitUntil(fn) {
    const deadline = Date.now() + 3000;
    while (!fn()) { if (Date.now() > deadline) throw Error('Fixture job did not reach its expected phase'); await tick(); }
  }
  function restoreHarness(options = {}) {
    const backups = path.join(dir, `backups-${++count}`); fs.mkdirSync(backups);
    const name = 'agent-agent_fixture-cold-2026-11-06_100000.tar.gz';
    const source = archive(content(options.version ?? '2026.9.9', options.state ?? 19, options.agentSchema ?? 24));
    fs.copyFileSync(source, path.join(backups, name));
    const originalHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const events = []; const rows = []; const calls = [];
    let helper = null; let helperArgs = null;
    class AgentJobBusyError extends Error { code = 'REV4A_AGENT_JOB_BUSY'; }
    let inspectCount = 0; let starts = 0; let extracts = 0; let backupsStarted = 0; let reapplied = 0;
    let current = { Id: 'container-id', Name: '/fixture-container', Image: 'image-id', State: { Running: true } };
    let releaseReady;
    let releaseInspection;
    const inspectionGate = options.deferInspection ? new Promise(resolve => { releaseInspection = resolve; }) : Promise.resolve();
    const ready = options.deferReady ? new Promise(resolve => { releaseReady = resolve; }) : Promise.resolve(options.ready !== false);
    const state = {
      activeRestoreAgentIds: () => new Set(rows.filter(row => row.status === 'restoring').map(row => row.agent_id)),
      insertRestore(agentId, file) { if (options.insertConflict) throw new AgentJobBusyError('Another lifecycle operation claimed this agent'); rows.push({ id: rows.length + 1, agent_id: agentId, file, status: 'restoring', phase: null, error: null, recovery_file: null, preflight_json: null, started_at: 1, finished_at: null }); return rows.length; },
      isRestoreActive: () => rows.some(row => row.status === 'restoring'),
      latestRestore: agentId => rows.filter(row => row.agent_id === agentId).at(-1) ?? null,
      markInterruptedRestores() { let changed = 0; for (const row of rows) if (row.status === 'restoring') { row.status = 'interrupted'; changed++; } return changed; },
      updateRestoreRow(id, values) { Object.assign(rows.find(row => row.id === id), values); events.push({ kind: 'state', ...values }); },
    };
    const module = { exports: {} };
    const context = {
      module, exports: module.exports, console, AbortSignal,
      process: { env: { REV4A_DOMAIN: options.domain } },
      require(spec) {
        if (spec.startsWith('node:')) return require(spec);
        if (spec === '@/lib/container') return { isValidAgentId: value => /^agent_[a-z]+$/.test(value) };
        if (spec === '@/lib/backups') return { isValidBackupFile: (_agent, file) => file === name };
        if (spec === '@/lib/rev4a-paths') return { BACKUPS_DIR: backups };
        if (spec === '@/lib/backups-volume') return { locateBackup: async () => options.location ?? 'dir' };
        if (spec === '@/lib/agent-busy') return { agentBusyReason: async () => null };
        if (spec === '@/lib/agent-restore-state') return state;
        if (spec === '@/lib/backup-inspection') return { async inspectBackupArchive(...args) { await inspectionGate; return inspectBackupArchive(...args); }, BackupInspectionError };
        if (spec === '@/lib/backup-compatibility') return { checkBackupCompatibility };
        if (spec === '@/lib/credentials/delivery') return { reapplyWhenReady: async () => { reapplied++; } };
        if (spec === '@/lib/domain-sync') return { syncDomainRoutes: async () => { events.push({ kind: 'domain-sync' }); } };
        if (spec === '@/lib/agent-readiness') return { waitForGatewayReady: async () => { events.push({ kind: 'readiness' }); return ready; } };
        if (spec === '@/lib/agent-recreate') return {
          async inspectAgentContainer() {
            inspectCount++;
            if (options.changedContainer && inspectCount > 1) return { ...current, Id: 'different-container' };
            return structuredClone(current);
          },
          async startAndVerifyContainer() { starts++; events.push({ kind: 'start' }); current.State.Running = true; return options.startFails ? { ok: false, error: 'network failure' } : { ok: true }; },
        };
        if (spec === '@/lib/cold-backup') return {
          async startColdBackup(_agent, opts) {
            backupsStarted++; events.push({ kind: 'backup', opts }); current.State.Running = false;
            if (options.replaceOriginal) fs.copyFileSync(archive(content('2026.10.10', 22, 27)), path.join(backups, name));
            if (options.deleteOriginal) fs.unlinkSync(path.join(backups, name));
            return { file: 'agent-agent_fixture-cold-recovery.tar.gz' };
          },
          async waitForColdBackup() { return { status: options.backupFails ? 'failed' : 'succeeded', file: 'agent-agent_fixture-cold-recovery.tar.gz' }; },
          async isColdBackupRunning() { return options.backupStillRunning === true; },
        };
        if (spec === '@/lib/docker-socket-path') return { dockerRequestJson: async (_method, url) => {
          if (url.startsWith('/containers/json?')) return [];
          if (!helper) throw new Error('Docker error 404: no helper');
          return helper;
        } };
        if (spec === '@/lib/agent-images') return {
          listLocalAgentImages: async () => [], containerOpenClawVersion: async () => options.target ?? '2026.10.10',
          async runDocker(args) {
            calls.push(Array.from(args));
            if (args[0] === 'stop') { if (args.at(-1) === 'fixture-container') current.State.Running = false; return; }
            if (args[0] === 'rm') { helper = null; return; }
            if (args[0] === 'create') {
              helperArgs = args;
              helper = { Config: { Labels: { 'rev4a.restore.agent': 'agent_fixture', 'rev4a.restore.id': String(rows.at(-1).id) } }, State: { Running: false, ExitCode: 0 } };
              return;
            }
            assert.equal(args[0], 'start');
            args = helperArgs;
            extracts++; events.push({ kind: 'extract' });
            const mount = args.find(value => value.endsWith(':/backup:ro'));
            const pin = path.join(mount.slice(0, -':/backup:ro'.length), 'source.tar.gz');
            const pinHash = createHash('sha256').update(fs.readFileSync(pin)).digest('hex');
            assert.equal(pinHash, originalHash, 'Extraction source changed after preflight');
            const row = rows.at(-1); assert.equal(row.recovery_file, 'agent-agent_fixture-cold-recovery.tar.gz');
            assert.equal(JSON.parse(row.preflight_json).archiveSha256, pinHash);
            if (options.extractFails) throw Error('sensitive native stderr');
          },
        };
        throw Error('Unexpected restore import ' + spec);
      },
    };
    vm.runInNewContext(compiled, context);
    return { api: module.exports, rows, calls, events, name, releaseReady, releaseInspection,
      get starts() { return starts; }, get extracts() { return extracts; }, get backupsStarted() { return backupsStarted; }, get reapplied() { return reapplied; } };
  }
  await test('incompatible restore rejects before backup, stop, extraction or start', async () => {
    const m = restoreHarness({ version: '2026.10.10', state: 22, agentSchema: 27, target: '2026.9.9' });
    assert.equal(await m.api.startAgentRestore('agent_fixture', m.name), 1);
    await waitUntil(() => m.rows[0].status !== 'restoring');
    assert.match(m.rows[0].error, /newer/);
    assert.equal(m.backupsStarted, 0); assert.equal(m.extracts, 0); assert.equal(m.starts, 0); assert.deepEqual(m.calls, []);
    assert.equal(m.rows[0].phase, 'preflight_failed');
  });
  await test('atomic lifecycle claim conflict becomes a safe refusal without a restore row', async () => {
    const m = restoreHarness({ insertConflict: true });
    await assert.rejects(m.api.startAgentRestore('agent_fixture', m.name), /Another lifecycle operation of this agent started/);
    assert.equal(m.rows.length, 0); assert.equal(m.backupsStarted, 0); assert.equal(m.extracts, 0);
  });
  await test('legacy volume and unavailable target refuse before touching a volume', async () => {
    for (const options of [{ location: 'volume' }, { target: '2026.10.99' }]) {
      const m = restoreHarness(options);
      await m.api.startAgentRestore('agent_fixture', m.name);
      await waitUntil(() => m.rows[0].status !== 'restoring');
      assert.match(m.rows[0].error, /legacy Docker volume|verified restore schema/);
      assert.equal(m.backupsStarted, 0); assert.equal(m.extracts, 0);
    }
  });
  await test('request returns a persisted job while slow preflight is still pending', async () => {
    const m = restoreHarness({ deferInspection: true });
    const id = await Promise.race([m.api.startAgentRestore('agent_fixture', m.name), new Promise((_, reject) => setTimeout(() => reject(Error('Request waited for full archive inspection')), 1000))]);
    assert.equal(id, 1); assert.equal(m.rows[0].status, 'restoring'); assert.equal(m.rows[0].phase, 'preflight');
    assert.equal(m.backupsStarted, 0); assert.equal(m.extracts, 0);
    m.releaseInspection(); await waitUntil(() => m.rows[0].status !== 'restoring'); assert.equal(m.rows[0].status, 'done');
  });
  await test('done requires actual Gateway readiness after recovery backup and extraction', async () => {
    const m = restoreHarness({ deferReady: true });
    await m.api.startAgentRestore('agent_fixture', m.name);
    await waitUntil(() => m.rows[0].phase === 'awaiting_ready');
    assert.equal(m.rows[0].status, 'restoring'); assert.equal(m.reapplied, 0);
    m.releaseReady(true); await waitUntil(() => m.rows[0].status === 'done');
    assert.equal(m.rows[0].phase, 'complete'); assert.equal(m.reapplied, 1);
    assert.deepEqual(m.events.filter(row => ['backup', 'extract', 'start', 'readiness'].includes(row.kind)).map(row => row.kind), ['backup', 'extract', 'start', 'readiness']);
    assert.ok(m.api.agentRestoreView('agent_fixture').preflight.archiveSha256);
  });
  await test('only a successful restore in Domain mode requests a route sync after readiness', async () => {
    for (const [opts, expected] of [[{}, false], [{ domain: 'rev4a.example.test', ready: false }, false],
      [{ domain: 'rev4a.example.test' }, true]]) {
      const m = restoreHarness(opts);
      await m.api.startAgentRestore('agent_fixture', m.name);
      await waitUntil(() => m.rows[0].status !== 'restoring');
      const sync = m.events.findIndex(event => event.kind === 'domain-sync');
      if (expected) {
        const done = m.events.findIndex(event => event.kind === 'state' && event.status === 'done');
        assert.ok(done >= 0 && sync > done);
      } else {
        assert.equal(sync, -1);
      }
    }
  });
  await test('source replacement/deletion after preflight cannot change pinned extraction bytes', async () => {
    for (const options of [{ replaceOriginal: true }, { deleteOriginal: true }]) {
      const m = restoreHarness(options); await m.api.startAgentRestore('agent_fixture', m.name);
      await waitUntil(() => m.rows[0].status !== 'restoring');
      assert.equal(m.rows[0].status, 'done'); assert.equal(m.extracts, 1);
    }
  });
  await test('failed cold backup never permits extraction and restarts untouched original data', async () => {
    const m = restoreHarness({ backupFails: true }); await m.api.startAgentRestore('agent_fixture', m.name);
    await waitUntil(() => m.rows[0].status !== 'restoring');
    assert.equal(m.extracts, 0); assert.equal(m.rows[0].status, 'failed'); assert.equal(m.starts, 1);
  });
  await test('container replacement after preflight aborts before backup or extraction', async () => {
    const m = restoreHarness({ changedContainer: true }); await m.api.startAgentRestore('agent_fixture', m.name);
    await waitUntil(() => m.rows[0].status !== 'restoring');
    assert.equal(m.backupsStarted, 0); assert.equal(m.extracts, 0); assert.match(m.rows[0].error, /changed after preflight/);
  });
  await test('extraction failure never starts partial data; recovery is retained without raw stderr', async () => {
    const m = restoreHarness({ extractFails: true }); await m.api.startAgentRestore('agent_fixture', m.name);
    await waitUntil(() => m.rows[0].status !== 'restoring');
    assert.equal(m.rows[0].status, 'failed'); assert.equal(m.starts, 0);
    assert.ok(m.rows[0].recovery_file); assert.match(m.rows[0].error, /recovery backup/);
    assert.ok(!m.rows[0].error.includes('sensitive native stderr'));
  });
  await test('network-only success cannot mark a non-ready restored Gateway done', async () => {
    const m = restoreHarness({ ready: false }); await m.api.startAgentRestore('agent_fixture', m.name);
    await waitUntil(() => m.rows[0].status !== 'restoring');
    assert.equal(m.rows[0].status, 'failed'); assert.equal(m.reapplied, 0); assert.match(m.rows[0].error, /did not finish startup/);
    assert.ok(m.calls.some(args => args[0] === 'stop'));
  });
  await test('legacy and recorded interrupted restores never overwrite or restart current work', async () => {
    for (const phase of [null, 'extracting', 'awaiting_ready']) {
      const m = restoreHarness();
      m.rows.push({ id: 1, agent_id: 'agent_fixture', status: 'restoring', file: m.name, phase, error: 'original audit', recovery_file: null });
      assert.equal(await m.api.recoverInterruptedRestores(), 1);
      assert.equal(m.rows[0].status, 'interrupted'); // State transition details use the real SQL tests in test-agent-restore-recovery.mjs.
      assert.equal(m.calls.length, 0); assert.equal(m.starts, 0); assert.equal(m.backupsStarted, 0);
      const before = JSON.stringify(m.rows); assert.equal(await m.api.recoverInterruptedRestores(), 0); assert.equal(JSON.stringify(m.rows), before);
    }
  });
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
