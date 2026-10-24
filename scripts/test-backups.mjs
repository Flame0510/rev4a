#!/usr/bin/env node
/**
 * Tests for the backups-as-files code: lib/backups.ts (name validation, fs listing/deletion on a
 * temp dir, no path traversal, merge of the dir and the legacy volume listings, pruning order) and
 * lib/backups-migration.ts (planner, resume, stop conditions, idempotence) with a fake runner.
 * No Docker, no network.
 *
 *   node scripts/test-backups.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = ${JSON.stringify(root)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = ROOT + '/' + specifier.slice(2);
    for (const e of ['.ts', '.js']) if (existsSync(base + e)) return next(pathToFileURL(base + e).href, context);
  }
  if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    const base = new URL(specifier, context.parentURL).pathname;
    for (const e of ['.ts', '.js']) if (existsSync(base + e)) return next(pathToFileURL(base + e).href, context);
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { type: 'json' } });
  return next(url, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(root + '/'));

const b = await import('../lib/backups.ts');
const mig = await import('../lib/backups-migration.ts');

// Child mode: REV4A_LEGACY_BACKUP_VOLUME is set to something invalid, so the legacy side must be disabled.
if (process.env.REV4A_TEST_CHILD === 'disabled-legacy') {
  const v = await import('../lib/backups-volume.ts');
  assert.equal(b.LEGACY_VOLUME_ENABLED, false);
  assert.notEqual(b.BACKUP_VOLUME, 'rev4a-backups');
  assert.equal(await v.legacyVolumeExists(), false);
  assert.deepEqual(await v.listVolumeBackups('a1'), []);
  assert.equal(await v.locateBackup('agent-a1-cold-2026-10-24_000000001.tar.gz', fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-bk-child-'))), null);
  console.log('child ok');
  process.exit(0);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-backups-test-'));
const put = (dir, name, size = 10, mtimeSec) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec);
};

// ── Names ────────────────────────────────────────────────────────────────────

await test('a valid name is agent-<id>-….tar.gz of that agent', () => {
  assert.equal(b.isValidBackupFile('a1', 'agent-a1-cold-2026-10-24_101010123.tar.gz'), true);
  assert.equal(b.isValidBackupFile('a1', 'agent-a1-preupdate-2026.9.9-2026-10-24_101010123.tar.gz'), true);
});
await test('another agent, wrong suffix, separators and traversal are refused', () => {
  for (const f of ['agent-a2-cold-2026-10-24_000000001.tar.gz', 'agent-a1-cold-2026-10-24_000000001.tar', 'agent-a1-../x.tar.gz', 'agent-a1-/etc/passwd.tar.gz',
    'agent-a1-..%2Fx.tar.gz', '../agent-a1-cold-2026-10-24_000000001.tar.gz', 'agent-a1-a\\b.tar.gz', 'agent-a1-cold-2026-10-24_000000001.tar.gz.partial', '', 'agent-a1-a b.tar.gz', 'agent-a1-x;rm.tar.gz']) {
    assert.equal(b.isValidBackupFile('a1', f), false, f);
  }
  assert.equal(b.isValidBackupFile('a1', undefined), false);
});
await test('isArchiveName and isTempName', () => {
  assert.equal(b.isArchiveName('agent-x-cold-2026-10-24_000000001.tar.gz'), true);
  assert.equal(b.isArchiveName('agent-x-cold-2026-10-24_000000001.tar.gz.partial'), false);
  assert.equal(b.isTempName('agent-x-cold-2026-10-24_000000001.tar.gz.partial'), true);
  assert.equal(b.isTempName('agent-x-cold-2026-10-24_000000001.tar.gz.migrating'), true);
  assert.equal(b.isTempName('agent-x-cold-2026-10-24_000000001.tar.gz.other'), false);
  assert.equal(b.isTempName('../agent-x-cold-2026-10-24_000000001.tar.gz.partial'), false);
});

// ── fs listing and deletion ──────────────────────────────────────────────────

await test('listing a missing directory is empty', () => {
  assert.deepEqual(b.listDirBackups('a1', path.join(os.tmpdir(), 'rev4a-does-not-exist-xyz')), []);
});
await test('listing returns only this agent, valid names, regular files, newest first, with size and mtime', () => {
  const d = tmp();
  put(d, 'agent-a1-cold-2026-10-24_000000001.tar.gz', 100, 1_000);
  put(d, 'agent-a1-prerecreate-2026-10-24_000000002.tar.gz', 200, 3_000);
  put(d, 'agent-a2-cold-2026-10-24_000000003.tar.gz', 5, 2_000);
  put(d, 'agent-a1-cold-2026-10-24_000000004.tar.gz.partial', 5, 4_000);
  put(d, 'notes.txt', 5);
  fs.mkdirSync(path.join(d, 'agent-a1-dir-5.tar.gz'));
  const list = b.listDirBackups('a1', d);
  assert.deepEqual(list.map((x) => x.name), ['agent-a1-prerecreate-2026-10-24_000000002.tar.gz', 'agent-a1-cold-2026-10-24_000000001.tar.gz']);
  assert.equal(list[0].sizeBytes, 200);
  assert.equal(list[0].epoch, 3_000);
  assert.equal(list[0].location, 'dir');
});
await test('a symlink is neither listed nor followed nor deleted through', () => {
  const d = tmp();
  const outside = tmp();
  put(outside, 'secret.tar.gz', 50);
  fs.symlinkSync(path.join(outside, 'secret.tar.gz'), path.join(d, 'agent-a1-cold-2026-10-24_000000009.tar.gz'));
  assert.deepEqual(b.listDirBackups('a1', d), []);
  assert.equal(b.dirHasBackup('agent-a1-cold-2026-10-24_000000009.tar.gz', d), false);
  assert.equal(b.removeDirFile('agent-a1-cold-2026-10-24_000000009.tar.gz', d), 'denied');
  assert.equal(fs.existsSync(path.join(outside, 'secret.tar.gz')), true);
});
await test('removeDirFile removes a file, reports missing, refuses names that are not archive names', () => {
  const d = tmp();
  put(d, 'agent-a1-cold-2026-10-24_000000001.tar.gz');
  assert.equal(b.removeDirFile('agent-a1-cold-2026-10-24_000000001.tar.gz', d), 'removed');
  assert.equal(b.removeDirFile('agent-a1-cold-2026-10-24_000000001.tar.gz', d), 'missing');
  assert.throws(() => b.removeDirFile('../x.tar.gz', d));
  assert.throws(() => b.removeDirFile('agent-a1-../../etc.tar.gz', d));
  assert.throws(() => b.removeDirFile('/etc/passwd', d));
});
await test('a file outside the directory is never touched by a traversal name', () => {
  const d = tmp();
  const parent = path.dirname(d);
  const victim = path.join(parent, 'agent-victim-cold-2026-10-24_000000001.tar.gz');
  fs.writeFileSync(victim, 'x');
  assert.throws(() => b.removeDirFile(`../${path.basename(victim)}`, d));
  assert.equal(fs.existsSync(victim), true);
  fs.unlinkSync(victim);
});
await test('removeAgentDirBackups removes archives and temp files of the agent, keeps the others', () => {
  const d = tmp();
  put(d, 'agent-a1-cold-2026-10-24_000000001.tar.gz');
  put(d, 'agent-a1-cold-2026-10-24_000000002.tar.gz.partial');
  put(d, 'agent-a2-cold-2026-10-24_000000001.tar.gz');
  const r = b.removeAgentDirBackups('a1', d);
  assert.deepEqual(r.removed.sort(), ['agent-a1-cold-2026-10-24_000000001.tar.gz', 'agent-a1-cold-2026-10-24_000000002.tar.gz.partial']);
  assert.deepEqual(r.denied, []);
  assert.equal(fs.existsSync(path.join(d, 'agent-a2-cold-2026-10-24_000000001.tar.gz')), true);
});
await test('listDirArchives returns archives and temp files with sizes', () => {
  const d = tmp();
  put(d, 'agent-a1-cold-2026-10-24_000000001.tar.gz', 7);
  put(d, 'agent-a1-cold-2026-10-24_000000002.tar.gz.migrating', 3);
  put(d, 'other.txt', 3);
  const l = b.listDirArchives(d).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(l, [{ name: 'agent-a1-cold-2026-10-24_000000001.tar.gz', sizeBytes: 7 }, { name: 'agent-a1-cold-2026-10-24_000000002.tar.gz.migrating', sizeBytes: 3 }]);
});

// ── Merge and pruning ────────────────────────────────────────────────────────

const E = (name, epoch, location, sizeBytes = 1) => ({ name, epoch, location, sizeBytes });

await test('merge dedups by name and prefers the directory', () => {
  const merged = b.mergeBackupListings(
    [E('agent-a-cold-2026-10-24_000000001.tar.gz', 10, 'dir', 111), E('agent-a-cold-2026-10-24_000000003.tar.gz', 30, 'dir')],
    [E('agent-a-cold-2026-10-24_000000001.tar.gz', 10, 'volume', 222), E('agent-a-cold-2026-10-24_000000002.tar.gz', 20, 'volume')],
  );
  assert.deepEqual(merged.map((x) => x.name), ['agent-a-cold-2026-10-24_000000003.tar.gz', 'agent-a-cold-2026-10-24_000000002.tar.gz', 'agent-a-cold-2026-10-24_000000001.tar.gz']);
  const one = merged.find((x) => x.name === 'agent-a-cold-2026-10-24_000000001.tar.gz');
  assert.equal(one.location, 'dir');
  assert.equal(one.sizeBytes, 111);
});
await test('merge of an empty volume is the directory listing', () => {
  const l = [E('agent-a-cold-2026-10-24_000000001.tar.gz', 10, 'dir')];
  assert.deepEqual(b.mergeBackupListings(l, []), l);
});
await test('staleByKind keeps the newest N of one kind and never touches other kinds', () => {
  const all = [
    E('agent-a-prerecreate-2026-10-24_000000001.tar.gz', 10, 'dir'), E('agent-a-prerecreate-2026-10-24_000000002.tar.gz', 20, 'dir'),
    E('agent-a-prerecreate-2026-10-24_000000003.tar.gz', 30, 'volume'), E('agent-a-preupdate-x-2026-10-24_000000001.tar.gz', 5, 'dir'),
    E('agent-a-cold-2026-10-24_000000001.tar.gz', 1, 'dir'),
  ];
  assert.deepEqual(b.staleByKind(all, 'a', 'prerecreate', 2), ['agent-a-prerecreate-2026-10-24_000000001.tar.gz']);
  assert.deepEqual(b.staleByKind(all, 'a', 'prerecreate', 5), []);
  assert.deepEqual(b.staleByKind(all, 'b', 'prerecreate', 0), []);
});

// ── One parser for backup names: ids that contain '-' ────────────────────────

const TSA = '2026-10-24_101010123';
await test('parseBackupName: every shape, anchored from the right', () => {
  const P = (n) => b.parseBackupName(n);
  assert.deepEqual(P(`agent-foo-cold-${TSA}.tar.gz`), { agentId: 'foo', kind: 'cold', label: null, timestamp: TSA });
  assert.deepEqual(P(`agent-foo-bar-prerecreate-${TSA}.tar.gz`)?.agentId, 'foo-bar');
  assert.deepEqual(P(`agent-foo-preupdate-2026.9.9-beta-${TSA}.tar.gz`), { agentId: 'foo', kind: 'preupdate', label: '2026.9.9-beta', timestamp: TSA });
  assert.equal(P(`agent-x-cold-y-cold-${TSA}.tar.gz`)?.agentId, 'x-cold-y');
  assert.equal(P(`agent-x-preupdate-1.0-cold-${TSA}.tar.gz`)?.agentId, 'x-preupdate-1.0');
  assert.equal(P('agent-x-2026-07-11_2151.tar.gz')?.kind, 'dated');
  assert.equal(P('agent-x-cold-1.tar.gz'), null);
  assert.equal(P('other.tar.gz'), null);
});
await test('an id that extends another id is never taken for it (valid-name check, list, prune, delete)', () => {
  const foo = `agent-foo-cold-${TSA}.tar.gz`;
  const bar = `agent-foo-bar-cold-${TSA}.tar.gz`;
  const cold = `agent-x-cold-y-cold-${TSA}.tar.gz`;
  assert.equal(b.isValidBackupFile('foo', foo), true);
  assert.equal(b.isValidBackupFile('foo', bar), false);
  assert.equal(b.isValidBackupFile('foo-bar', bar), true);
  assert.equal(b.isValidBackupFile('x', cold), false);
  assert.equal(b.isValidBackupFile('x-cold-y', cold), true);
  const d = tmp();
  put(d, foo, 10, 1000); put(d, bar, 10, 2000); put(d, cold, 10, 3000);
  put(d, `agent-foo-bar-cold-${TSA}.tar.gz.partial`, 5);
  assert.deepEqual(b.listDirBackups('foo', d).map((x) => x.name), [foo]);
  assert.deepEqual(b.listDirBackups('foo-bar', d).map((x) => x.name), [bar]);
  assert.deepEqual(b.listDirBackups('x', d).map((x) => x.name), []);
  const E = (name, epoch) => ({ name, sizeBytes: 1, epoch, location: 'dir' });
  const all = [E(foo, 1), E(bar, 2), E(`agent-foo-cold-2026-10-25_101010123.tar.gz`, 3)];
  assert.deepEqual(b.staleByKind(all, 'foo', 'cold', 1), [foo]);
  assert.deepEqual(b.staleByKind(all, 'foo-bar', 'cold', 1), []);
  const r = b.removeAgentDirBackups('foo', d);
  assert.deepEqual(r.removed, [foo]);
  assert.ok(fs.existsSync(path.join(d, bar)) && fs.existsSync(path.join(d, cold)), 'foo-bar and x-cold-y files must survive deleting foo');
  assert.ok(fs.existsSync(path.join(d, `agent-foo-bar-cold-${TSA}.tar.gz.partial`)));
  assert.deepEqual(b.removeAgentDirBackups('foo-bar', d).removed.sort(), [bar, `agent-foo-bar-cold-${TSA}.tar.gz.partial`].sort());
});
await test('agentIdOfBackup (busy check) uses the same parser, including temporary names', () => {
  assert.equal(mig.agentIdOfBackup(`agent-foo-bar-cold-${TSA}.tar.gz`), 'foo-bar');
  assert.equal(mig.agentIdOfBackup(`agent-foo-bar-cold-${TSA}.tar.gz.migrating`), 'foo-bar');
});

// ── Migration: an unreadable archive does not block the larger ones ──────────

await test('runner: a copy that does not verify is skipped, reported, kept in the volume; larger files still move', async () => {
  const h = fakeHost({
    volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-a-cold-2026-10-24_000000002.tar.gz': 6, 'agent-a-cold-2026-10-24_000000003.tar.gz': 7 },
    verifyFail: ['agent-a-cold-2026-10-24_000000002.tar.gz'],
  });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /could not be verified/);
  assert.match(s.reason, /agent-a-cold-2026-10-24_000000002/);
  assert.equal(s.moved, 2);
  assert.equal(s.skipped.length, 1);
  assert.equal(s.skipped[0].name, 'agent-a-cold-2026-10-24_000000002.tar.gz');
  assert.match(s.skipped[0].reason, /read back/);
  assert.deepEqual([...h.volumeFiles.keys()], ['agent-a-cold-2026-10-24_000000002.tar.gz']);
  assert.equal(h.volumeRemoved, false);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'copy').map((c) => c[1]).sort(), [
    'agent-a-cold-2026-10-24_000000001.tar.gz', 'agent-a-cold-2026-10-24_000000002.tar.gz', 'agent-a-cold-2026-10-24_000000003.tar.gz']);
});
await test('runner: a space or Docker failure still stops the run (only verification failures are skipped)', async () => {
  const h = fakeHost({
    volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-a-cold-2026-10-24_000000002.tar.gz': 6 },
    failCopy: ['agent-a-cold-2026-10-24_000000001.tar.gz'],
  });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.equal(s.skipped.length, 0);
  assert.equal(h.calls.filter((c) => c[0] === 'copy').length, 1);
});

// ── Migration planner ────────────────────────────────────────────────────────

const F = (name, sizeBytes) => ({ name, sizeBytes });

await test('agentIdOfBackup reads the id from every name shape', () => {
  assert.equal(mig.agentIdOfBackup('agent-prometheus-cold-2026-10-24_101010123.tar.gz'), 'prometheus');
  assert.equal(mig.agentIdOfBackup('agent-my-agent-preupdate-2026.9.9-2026-10-24_101010123.tar.gz'), 'my-agent');
  assert.equal(mig.agentIdOfBackup('agent-x-prerecreate-2026-10-24_000000001.tar.gz'), 'x');
  assert.equal(mig.agentIdOfBackup('agent-x-2026-07-11_2151.tar.gz'), 'x');
  assert.equal(mig.agentIdOfBackup('other.tar.gz'), null);
});
await test('planner: copy what is only in the volume, smallest first', () => {
  const p = mig.planMigration([F('agent-a-cold-2026-10-24_000000002.tar.gz', 50), F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)], []);
  assert.deepEqual(p.map((s) => [s.name, s.action]), [['agent-a-cold-2026-10-24_000000001.tar.gz', 'copy'], ['agent-a-cold-2026-10-24_000000002.tar.gz', 'copy']]);
});
await test('planner: same name and size in the directory skips the copy and drops the volume copy', () => {
  const p = mig.planMigration([F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)], [F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)]);
  assert.deepEqual(p.map((s) => s.action), ['drop-volume-copy']);
});
await test('planner: same name, other size is a conflict', () => {
  const p = mig.planMigration([F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)], [F('agent-a-cold-2026-10-24_000000001.tar.gz', 6)]);
  assert.deepEqual(p.map((s) => s.action), ['conflict']);
});
await test('planner: a .migrating leftover is redone when its source is in the volume, removed when not', () => {
  const redo = mig.planMigration([F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)], [F('agent-a-cold-2026-10-24_000000001.tar.gz.migrating', 2)]);
  assert.deepEqual(redo.map((s) => s.action), ['copy']);
  const stale = mig.planMigration([], [F('agent-a-cold-2026-10-24_000000001.tar.gz.migrating', 2)]);
  assert.deepEqual(stale.map((s) => [s.name, s.action]), [['agent-a-cold-2026-10-24_000000001.tar.gz.migrating', 'remove-stale']]);
});
await test('planner: nothing to do for an empty volume', () => {
  assert.deepEqual(mig.planMigration([], [F('agent-a-cold-2026-10-24_000000001.tar.gz', 5)]), []);
});

// ── Runner with a fake host ──────────────────────────────────────────────────

function fakeHost(opts = {}) {
  const host = {
    volumeFiles: new Map(Object.entries(opts.volume ?? {})), // name -> size
    dirFiles: new Map(Object.entries(opts.dir ?? {})),
    volumeOther: opts.volumeOther ?? 0,
    volumeTemps: new Set(opts.temps ?? []),
    calls: [],
    logs: [],
    exists: 'exists' in opts ? opts.exists : true,
    free: opts.free ?? null,
    busy: new Set(opts.busy ?? []),
    failCopy: new Set(opts.failCopy ?? []),
    verifyFail: new Set(opts.verifyFail ?? []),
    inUse: opts.inUse ?? false,
    volumeRemoved: false,
    sleeps: 0,
  };
  host.deps = {
    volumeExists: async () => (host.volumeRemoved ? false : host.exists),
    listVolumeArchives: async () => [...host.volumeFiles].map(([name, sizeBytes]) => ({ name, sizeBytes })),
    listDirFiles: () => [...host.dirFiles].map(([name, sizeBytes]) => ({ name, sizeBytes })),
    freeBytes: () => host.free,
    isBusy: async (name) => host.busy.has(name),
    copyVerified: async (name) => {
      host.calls.push(['copy', name]);
      if (host.verifyFail.has(name)) throw new mig.CopyVerificationError('the copy does not read back');
      if (host.failCopy.has(name)) { host.dirFiles.set(`${name}.migrating`, 1); throw new Error('read-back failed'); }
      host.dirFiles.delete(`${name}.migrating`);
      host.dirFiles.set(name, host.volumeFiles.get(name));
    },
    removeFromVolume: async (name) => {
      host.calls.push(['rmvol', name]);
      if (name.endsWith('.partial')) { host.volumeTemps.delete(name); return; }
      // Nothing may leave the volume before a final copy exists in the directory.
      assert.ok(host.dirFiles.has(name), `volume copy of ${name} removed without a copy in the directory`);
      host.volumeFiles.delete(name);
    },
    removeDirFile: (name) => { host.calls.push(['rmdir', name]); host.dirFiles.delete(name); },
    listVolumeTemps: async () => [...host.volumeTemps],
    volumeEmpty: async () => host.volumeFiles.size === 0 && host.volumeTemps.size === 0 && host.volumeOther === 0,
    volumeInUse: async () => host.inUse,
    removeVolume: async () => { host.calls.push(['rmvolume']); host.volumeRemoved = true; },
    sleep: async () => { host.sleeps++; if (host.busy.size) host.busy.clear(); },
    log: (l) => host.logs.push(l),
  };
  return host;
}

await test('runner: moves every file (copy before delete), then removes the empty unused volume', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-b-cold-2026-10-24_000000001.tar.gz': 9 } });
  const states = [];
  const s = await mig.runMigration(h.deps, (x) => states.push(x.status));
  assert.equal(s.status, 'done');
  assert.equal(s.moved, 2);
  assert.deepEqual([...h.dirFiles.keys()].sort(), ['agent-a-cold-2026-10-24_000000001.tar.gz', 'agent-b-cold-2026-10-24_000000001.tar.gz']);
  assert.equal(h.volumeRemoved, true);
  assert.equal(states[0], 'running');
  assert.ok(h.logs.some((l) => /2 moved|1 moved/.test(l)));
});
await test('runner: a second run is a no-op (volume gone)', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 } });
  await mig.runMigration(h.deps);
  h.calls.length = 0;
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.deepEqual(h.calls, []);
});
await test('runner: the volume is kept when it holds other files or a container uses it', async () => {
  const a = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, volumeOther: 1 });
  assert.equal((await mig.runMigration(a.deps)).status, 'done');
  assert.equal(a.volumeRemoved, false);
  const c = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, inUse: true });
  assert.equal((await mig.runMigration(c.deps)).status, 'done');
  assert.equal(c.volumeRemoved, false);
});
await test('runner: no volume means done at once', async () => {
  const h = fakeHost({ exists: false });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.deepEqual(h.calls, []);
});
await test('runner: Docker not answering stops with a reason after the retries', async () => {
  const h = fakeHost({ exists: null });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /Docker/);
  assert.equal(h.sleeps, 2);
});
await test('runner: resumable - a leftover .migrating is redone, already moved files are skipped', async () => {
  const h = fakeHost({
    volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-a-cold-2026-10-24_000000002.tar.gz': 7 },
    dir: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-a-cold-2026-10-24_000000002.tar.gz.migrating': 3 },
  });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'copy'), [['copy', 'agent-a-cold-2026-10-24_000000002.tar.gz']]);
  assert.equal(h.dirFiles.has('agent-a-cold-2026-10-24_000000002.tar.gz.migrating'), false);
  assert.equal(h.dirFiles.get('agent-a-cold-2026-10-24_000000002.tar.gz'), 7);
});
await test('runner: a stale .migrating whose source is gone is removed', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, dir: { 'agent-z-cold-2026-10-24_000000001.tar.gz.migrating': 3 } });
  await mig.runMigration(h.deps);
  assert.equal(h.dirFiles.has('agent-z-cold-2026-10-24_000000001.tar.gz.migrating'), false);
});
await test('runner: not enough free space stops before copying and deletes nothing', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 500 * 1024 * 1024 }, free: 100 * 1024 * 1024 });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /free space/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.volumeFiles.size, 1);
});
await test('runner: a failed copy stops, keeps the volume file and moves nothing further', async () => {
  const h = fakeHost({
    volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-a-cold-2026-10-24_000000002.tar.gz': 6, 'agent-a-cold-2026-10-24_000000003.tar.gz': 7 },
    failCopy: ['agent-a-cold-2026-10-24_000000002.tar.gz'],
  });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /agent-a-cold-2/);
  assert.equal(s.moved, 1);
  assert.deepEqual([...h.volumeFiles.keys()].sort(), ['agent-a-cold-2026-10-24_000000002.tar.gz', 'agent-a-cold-2026-10-24_000000003.tar.gz']);
  assert.equal(h.volumeRemoved, false);
  // Resume: the failure is gone, the rest is moved and the leftover redone.
  h.failCopy.clear();
  const again = await mig.runMigration(h.deps);
  assert.equal(again.status, 'done');
  assert.equal(h.volumeFiles.size, 0);
});
await test('runner: a file of a busy agent waits and is moved on a later pass', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-b-cold-2026-10-24_000000001.tar.gz': 6 }, busy: ['agent-a-cold-2026-10-24_000000001.tar.gz'] });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.equal(h.sleeps, 1);
  assert.equal(h.volumeFiles.size, 0);
  // The free file went first; the busy one waited for the next pass.
  assert.equal(h.calls[0][1], 'agent-b-cold-2026-10-24_000000001.tar.gz');
});
await test('runner: a name in both places with different sizes is left alone and reported', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, dir: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 6 } });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /different sizes/);
  assert.equal(h.volumeFiles.size, 1);
  assert.equal(h.volumeRemoved, false);
});
await test('runner: same name and size in the directory drops the volume copy without copying', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, dir: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 } });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'copy'), []);
});
await test('runner: an exception from the host lands in the state, never thrown', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 } });
  h.deps.listVolumeArchives = async () => { throw new Error('boom'); };
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.equal(s.reason, 'boom');
});

// ── Legacy volume: fail closed, 404 is absent, null is not absent ────────────

await test('resolveLegacyVolume: unset is the default, valid is kept, invalid is disabled (never the default)', () => {
  assert.equal(b.resolveLegacyVolume(undefined), 'rev4a-backups');
  assert.equal(b.resolveLegacyVolume('  '), 'rev4a-backups');
  assert.equal(b.resolveLegacyVolume('r4a-test-x'), 'r4a-test-x');
  for (const bad of ['bad name', '../x', '-lead', 'a;b', 'x'.repeat(200)]) assert.equal(b.resolveLegacyVolume(bad), null, bad);
});
await test('an invalid REV4A_LEGACY_BACKUP_VOLUME disables the volume side (child process)', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, REV4A_TEST_CHILD: 'disabled-legacy', REV4A_LEGACY_BACKUP_VOLUME: 'bad name!' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /child ok/);
  assert.match(r.stderr, /not a valid Docker volume name/);
});

const sockDir = tmp();
const sockPath = path.join(sockDir, 'docker.sock');
let dockerMode = 404;
const dockerSrv = http.createServer((req, res) => {
  res.statusCode = dockerMode;
  res.setHeader('content-type', 'application/json');
  res.end(dockerMode === 200 ? JSON.stringify({ Name: 'rev4a-backups' }) : JSON.stringify({ message: 'x' }));
});
await new Promise((r) => dockerSrv.listen(sockPath, r));
process.env.DOCKER_HOST = `unix://${sockPath}`;
const vol = await import('../lib/backups-volume.ts');

await test('legacyVolumeExists: 404 is false, 200 is true, a real failure is null', async () => {
  dockerMode = 404; assert.equal(await vol.legacyVolumeExists(), false);
  dockerMode = 200; assert.equal(await vol.legacyVolumeExists(), true);
  dockerMode = 500; assert.equal(await vol.legacyVolumeExists(), null);
});
await test('isDockerNotFound matches only a 404 from the request helper', () => {
  assert.equal(vol.isDockerNotFound(new Error('Docker error 404: {"message":"no such volume"}')), true);
  assert.equal(vol.isDockerNotFound(new Error('Docker error 500: 404')), false);
  assert.equal(vol.isDockerNotFound(new Error('Docker socket not found')), false);
});
await test('a fresh install (404): the migration is done, locateBackup is null, listing is the directory', async () => {
  dockerMode = 404;
  const dir = tmp();
  put(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz', 7);
  assert.equal(await vol.locateBackup('agent-a1-cold-2026-10-24_000000002.tar.gz', dir), null);
  assert.equal(await vol.locateBackup('agent-a1-cold-2026-10-24_000000001.tar.gz', dir), 'dir');
  assert.deepEqual((await vol.listAgentBackups('a1', dir)).map((x) => x.name), ['agent-a1-cold-2026-10-24_000000001.tar.gz']);
  const h = fakeHost({ exists: await vol.legacyVolumeExists() });
  assert.equal((await mig.runMigration(h.deps)).status, 'done');
});
await test('Docker not answering (null): listing, locate and delete fail loudly and delete nothing', async () => {
  dockerMode = 500;
  const dir = tmp();
  put(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz', 7);
  await assert.rejects(vol.listVolumeBackups('a1'), /did not answer/);
  await assert.rejects(vol.listAgentBackups('a1', dir), /did not answer/);
  await assert.rejects(vol.locateBackup('agent-a1-cold-2026-10-24_000000002.tar.gz', dir), /did not answer/);
  await assert.rejects(vol.deleteBackupFile('agent-a1-cold-2026-10-24_000000001.tar.gz', dir), /did not answer/);
  assert.ok(fs.existsSync(path.join(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'a failed check must not delete the file');
  const failed = await vol.deleteAgentBackups('a1', dir);
  assert.ok(failed.length > 0, 'agent deletion reports the volume side as failed');
});
await test('delete with the volume absent (404) removes the directory file', async () => {
  dockerMode = 404;
  const dir = tmp();
  put(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz', 7);
  await vol.deleteBackupFile('agent-a1-cold-2026-10-24_000000001.tar.gz', dir);
  assert.ok(!fs.existsSync(path.join(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz')));
});
dockerSrv.close();

// ── Migration: busy re-check, temps, space with a leftover, stop reasons ─────

await test('runner: the volume copy is kept when the agent became busy during the copy', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 } });
  const real = h.deps.copyVerified;
  h.deps.copyVerified = async (n) => { await real(n); h.busy.add(n); };
  let first = true;
  const realBusy = h.deps.isBusy;
  h.deps.isBusy = async (n) => { if (first && h.calls.length === 0) { first = false; return false; } return realBusy(n); };
  const removedBeforeClear = [];
  const realRm = h.deps.removeFromVolume;
  h.deps.removeFromVolume = async (n) => { removedBeforeClear.push(h.busy.has(n)); await realRm(n); };
  const s = await mig.runMigration(h.deps);
  assert.ok(!removedBeforeClear.includes(true), 'the volume copy was removed while the agent was busy');
  assert.equal(s.status, 'done');
});
await test('runner: a leftover .migrating counts as free space for its own redo', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 100 }, dir: { 'agent-a-cold-2026-10-24_000000001.tar.gz.migrating': 100 }, free: mig.MIGRATION_HEADROOM_BYTES + 50 });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.equal(s.moved, 1);
});
await test('runner: .partial files of an older release are removed from the volume so it can empty', async () => {
  const h = fakeHost({ volume: {}, temps: ['agent-a-cold-2026-10-24_000000001.tar.gz.partial'] });
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'done');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'rmvol').map((c) => c[1]), ['agent-a-cold-2026-10-24_000000001.tar.gz.partial']);
  assert.equal(h.volumeRemoved, true);
});
await test('runner: a leftover remove-stale has its own stop reason, not "busy"', async () => {
  const h = fakeHost({ volume: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5 }, dir: { 'agent-a-cold-2026-10-24_000000001.tar.gz': 5, 'agent-z-cold-2026-10-24_000000001.tar.gz.migrating': 3 } });
  h.deps.removeDirFile = () => {}; // cannot be removed
  const s = await mig.runMigration(h.deps);
  assert.equal(s.status, 'stopped');
  assert.match(s.reason, /leftover temporary copy/);
  assert.doesNotMatch(s.reason, /busy/);
});

// ── restore.sh keeps the agent backups ───────────────────────────────────────

const restoreSh = path.join(root, 'scripts', 'restore.sh');
function restoreCase({ archiveBackups = false, failMv = false, failStage = false, symlinkBackups = false, asideTaken = false }) {
  const home = fs.realpathSync(tmp());
  const data = path.join(home, 'data-dir');
  const src = path.join(home, 'src');
  for (const d of [data, path.join(src, 'data')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(src, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(src, 'data', 'x.db'), 'new');
  fs.writeFileSync(path.join(data, '.env'), 'A=0\n');
  fs.mkdirSync(path.join(data, 'data'));
  const realBackups = symlinkBackups ? path.join(home, 'elsewhere') : path.join(data, 'backups');
  fs.mkdirSync(realBackups);
  if (symlinkBackups) fs.symlinkSync(realBackups, path.join(data, 'backups'));
  fs.writeFileSync(path.join(realBackups, 'agent-a1-cold-2026-10-24_000000001.tar.gz'), 'CURRENT');
  fs.writeFileSync(path.join(realBackups, 'agent-a1-cold-2026-10-24_000000002.tar.gz'), 'CURRENT2');
  if (archiveBackups) {
    fs.mkdirSync(path.join(src, 'backups'));
    fs.writeFileSync(path.join(src, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz'), 'FROM-ARCHIVE');
    fs.writeFileSync(path.join(src, 'backups', 'agent-a1-cold-2026-10-24_000000003.tar.gz'), 'ONLY-IN-ARCHIVE');
    if (asideTaken) fs.writeFileSync(path.join(src, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz.from-restore-archive'), 'TAKEN');
  }
  const archive = path.join(home, 'r.tar.gz');
  execFileSync('tar', ['-C', src, '-czf', archive, '.']);
  const shim = path.join(home, 'shim');
  fs.mkdirSync(shim);
  const realMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(shim, 'mv'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *.rev4a-replaced.*) exit 1;; esac; done\nexec ${realMv} "$@"\n`, { mode: 0o755 });
  // The script refuses to run while a real Rev4a is up on the machine: the test must not depend on that.
  fs.writeFileSync(path.join(shim, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  if (failStage) fs.writeFileSync(path.join(shim, 'mv'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *.rev4a-restore.*) exit 1;; esac; done\nexec ${realMv} "$@"\n`, { mode: 0o755 });
  else if (!failMv) fs.unlinkSync(path.join(shim, 'mv'));
  const r = spawnSync('bash', [restoreSh, archive], {
    env: { ...process.env, HOME: home, REV4A_DATA_DIR: data, PATH: shim + ':' + process.env.PATH },
    encoding: 'utf8',
  });
  return { r, home, data, realBackups };
}
const read = (p) => fs.readFileSync(p, 'utf8');
const anywhere = (home, content) => execFileSync('grep', ['-rl', content, home, '--include=agent-*'], { encoding: 'utf8' });

await test('restore.sh: a normal restore keeps the current backups', () => {
  const { r, data } = restoreCase({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'CURRENT');
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000002.tar.gz')), 'CURRENT2');
  assert.equal(read(path.join(data, 'data', 'x.db')), 'new');
});
await test('restore.sh: an archive that holds backups/ never overwrites or deletes the current ones', () => {
  const { r, data } = restoreCase({ archiveBackups: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'CURRENT');
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000002.tar.gz')), 'CURRENT2');
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000003.tar.gz')), 'ONLY-IN-ARCHIVE');
  const leftovers = fs.readdirSync(path.dirname(data)).filter((n) => n.startsWith('.rev4a-'));
  assert.deepEqual(leftovers, []);
});
await test('restore.sh: when moving the data directory fails, the backups still exist and the message says where', () => {
  const { r, home, data } = restoreCase({ failMv: true });
  assert.notEqual(r.status, 0);
  const found = anywhere(home, 'CURRENT');
  assert.match(found, /agent-a1-cold-2026-10-24_000000001\.tar\.gz/);
  assert.match(found, /agent-a1-cold-2026-10-24_000000002\.tar\.gz/);
  // back in place, or reported in a kept folder
  const inPlace = fs.existsSync(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz'));
  assert.ok(inPlace || /NOT deleted: they are in /.test(r.stderr), r.stderr);
});

await test('restore.sh: a backups folder that is a symbolic link stays a link to the same folder', () => {
  const { r, data, realBackups } = restoreCase({ symlinkBackups: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.lstatSync(path.join(data, 'backups')).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(data, 'backups')), fs.realpathSync(realBackups));
  assert.equal(read(path.join(realBackups, 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'CURRENT');
  assert.equal(read(path.join(realBackups, 'agent-a1-cold-2026-10-24_000000002.tar.gz')), 'CURRENT2');
});
await test('restore.sh: the archive file never takes a current name, and a taken aside name gets a number', () => {
  const { r, data } = restoreCase({ archiveBackups: true, asideTaken: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = path.join(data, 'backups');
  assert.equal(read(path.join(dir, 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'CURRENT');
  const asides = fs.readdirSync(dir).filter((n) => n.includes('.from-restore-archive')).map((n) => read(path.join(dir, n))).sort();
  assert.deepEqual(asides, ['FROM-ARCHIVE', 'TAKEN']);
});
await test('restore.sh: a swap that fails between the two moves restores the old data and keeps the backups', () => {
  const { r, home, data } = restoreCase({ failStage: true });
  assert.notEqual(r.status, 0);
  assert.equal(read(path.join(data, '.env')), 'A=0\n', 'the previous data is back in place');
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000001.tar.gz')), 'CURRENT');
  assert.equal(read(path.join(data, 'backups', 'agent-a1-cold-2026-10-24_000000002.tar.gz')), 'CURRENT2');
  assert.match(anywhere(home, 'CURRENT'), /agent-a1-cold/);
  assert.match(r.stderr, /previous data directory|data directory is/);
});

console.log(`\n${passed} passed`);
