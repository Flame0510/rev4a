#!/usr/bin/env node
/**
 * Tests for the Workspace folder listing (`list=1`) and the page's URL state: the argv, the parser (NUL
 * records, odd names, hidden files with the read-only exception, sorting, the cap) and the pure URL helpers
 * in app/workspace/url-state.ts. A run against a real temp folder happens only where `find` has GNU
 * `-printf` (Linux, CI). No Docker, no network.
 *
 *   node scripts/test-workspace-list.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import('../lib/workspace-fs.ts');
const u = await import('../app/workspace/url-state.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}\n`, e);
    process.exit(1);
  }
}

const ROOT = '/root/.openclaw/workspace';
const rec = (type, size, mtime, name) => `${type}|${size}|${mtime}|${name}\0`;

await test('listArgv: a constant script, the folder is one argv element', () => {
  const dir = `${ROOT}/a b/$(touch x);y`;
  const argv = m.listArgv(dir);
  assert.deepEqual(argv.slice(0, 4), ['sh', '-c', m.LIST_SCRIPT, 'sh']);
  assert.equal(argv[4], dir);
  assert.ok(!m.LIST_SCRIPT.includes(dir));
  assert.deepEqual(argv.slice(5), ['-mindepth', '1', '-maxdepth', '1', '-printf', '%y|%s|%T@|%f\\0']);
  assert.equal(argv.filter((a) => a === dir).length, 1);
  // The same constant script for any folder.
  assert.equal(m.listArgv(ROOT)[2], argv[2]);
});

await test('parseList: NUL records with names holding |, newline, spaces and unicode', () => {
  const out = rec('f', 12, '1750000000.5', 'a|b|c.txt') + rec('f', 3, '1750000001.0', 'two\nlines.md')
    + rec('d', 4096, '1750000002.25', 'with space') + rec('f', 0, '1750000003', 'caffè 日本.txt');
  const { entries, truncated } = m.parseList(out, ROOT);
  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => e.name), ['with space', 'a|b|c.txt', 'caffè 日本.txt', 'two\nlines.md']);
  const pipe = entries.find((e) => e.name === 'a|b|c.txt');
  assert.equal(pipe.path, `${ROOT}/a|b|c.txt`);
  assert.equal(pipe.relPath, 'a|b|c.txt');
  assert.equal(pipe.type, 'file');
  assert.equal(pipe.isFile, true);
  assert.equal(pipe.isDirectory, false);
  assert.equal(pipe.size, 12);
  assert.equal(pipe.mtimeMs, 1750000000500);
  const dir = entries.find((e) => e.name === 'with space');
  assert.equal(dir.type, 'directory');
  assert.equal(dir.size, 0, 'a folder has no size');
  assert.equal(dir.isDirectory, true);
});

await test('parseList: relPath is relative to the workspace root, in a nested folder too', () => {
  const { entries } = m.parseList(rec('f', 1, '1', 'x.md'), `${ROOT}/skills/deep`);
  assert.equal(entries[0].path, `${ROOT}/skills/deep/x.md`);
  assert.equal(entries[0].relPath, 'skills/deep/x.md');
});

await test('parseList: broken records are skipped', () => {
  const out = `garbage\0f|1|2\0${rec('f', 1, '1', 'ok.txt')}\0\0${rec('f', 1, '1', '')}`;
  assert.deepEqual(m.parseList(out, ROOT).entries.map((e) => e.name), ['ok.txt']);
});

await test('parseList: dot-entries are hidden unless asked, read-only mount roots are always listed', () => {
  const out = rec('d', 0, '1', '.rev4a') + rec('d', 0, '1', '.git') + rec('f', 1, '1', '.env') + rec('f', 1, '1', 'a.md') + rec('d', 0, '1', 'node_modules');
  const ro = [`${ROOT}/.rev4a`];
  const hiddenOff = m.parseList(out, ROOT, { readOnlyPaths: ro }).entries;
  assert.deepEqual(hiddenOff.map((e) => e.name), ['.rev4a', 'node_modules', 'a.md']);
  assert.equal(hiddenOff[0].readOnly, true);
  assert.equal(hiddenOff[1].readOnly, undefined, 'the key is absent elsewhere');
  const hiddenOn = m.parseList(out, ROOT, { readOnlyPaths: ro, hidden: true }).entries;
  assert.deepEqual(hiddenOn.map((e) => e.name), ['.git', '.rev4a', 'node_modules', '.env', 'a.md']);
  // Without a mount, .rev4a is an ordinary hidden folder.
  assert.deepEqual(m.parseList(out, ROOT).entries.map((e) => e.name), ['node_modules', 'a.md']);
});

await test('parseList: node_modules and .git are listed as folders when hidden files are on', () => {
  const out = rec('d', 0, '1', 'node_modules') + rec('d', 0, '1', '.git');
  const e = m.parseList(out, ROOT, { hidden: true }).entries;
  assert.deepEqual(e.map((x) => [x.name, x.type]), [['.git', 'directory'], ['node_modules', 'directory']]);
});

await test('parseList: entries inside a read-only mount, and forceReadOnly, carry readOnly', () => {
  const ro = [`${ROOT}/.rev4a`];
  const inside = m.parseList(rec('f', 1, '1', 'AGENTS.md') + rec('d', 0, '1', '.hidden'), `${ROOT}/.rev4a`, { readOnlyPaths: ro, hidden: true }).entries;
  assert.ok(inside.length === 2 && inside.every((e) => e.readOnly === true));
  const forced = m.parseList(rec('f', 1, '1', 'a.md'), `${ROOT}/link`, { forceReadOnly: true }).entries;
  assert.equal(forced[0].readOnly, true);
});

await test('parseList: folders first, then by name', () => {
  const out = rec('f', 1, '1', 'b.md') + rec('d', 0, '1', 'zeta') + rec('f', 1, '1', 'A.md') + rec('d', 0, '1', 'alpha') + rec('f', 1, '1', 'a.md');
  const e = m.parseList(out, ROOT).entries;
  assert.deepEqual(e.slice(0, 2).map((x) => x.type), ['directory', 'directory']);
  assert.deepEqual(e.slice(0, 2).map((x) => x.name), ['alpha', 'zeta']);
  assert.ok(e.slice(2).every((x) => x.type === 'file'));
  // The same comparator the tree uses.
  const sorted = [...e].sort(m.compareWorkspaceEntries);
  assert.deepEqual(sorted.map((x) => x.name), e.map((x) => x.name));
});

await test('parseList: the cap is 5000 entries and sets truncated', () => {
  assert.equal(m.LIST_MAX_ENTRIES, 5000);
  const build = (n) => Array.from({ length: n }, (_, i) => rec('f', 1, '1', `f${String(i).padStart(6, '0')}.txt`)).join('');
  const exact = m.parseList(build(5000), ROOT);
  assert.equal(exact.entries.length, 5000);
  assert.equal(exact.truncated, false);
  const over = m.parseList(build(5001) + rec('d', 0, '1', 'zz-folder'), ROOT);
  assert.equal(over.entries.length, 5000);
  assert.equal(over.truncated, true);
  assert.equal(over.entries[0].name, 'zz-folder', 'the cut is applied after sorting, so folders survive');
  const small = m.parseList(build(5), ROOT, { limit: 3 });
  assert.equal(small.entries.length, 3);
  assert.equal(small.truncated, true);
});

await test('parseList: 50,000 entries are parsed fast', () => {
  const out = Array.from({ length: 50000 }, (_, i) => rec(i % 10 === 0 ? 'd' : 'f', i, String(1750000000 + i), `entry-${i}.txt`)).join('');
  const t = Date.now();
  const r = m.parseList(out, ROOT);
  assert.equal(r.entries.length, 5000);
  assert.equal(r.truncated, true);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

// ── URL state ────────────────────────────────────────────────────────────────

const KNOWN = ['agent_8ba21f83', 'openclaw-atlas'];

await test('parseBrowseState: a valid agent, file and hidden flag', () => {
  const s = u.parseBrowseState({ agent: 'agent_8ba21f83', file: 'skills/a/SKILL.md', hidden: '1' }, KNOWN);
  assert.deepEqual(s, { agent: 'agent_8ba21f83', file: `${ROOT}/skills/a/SKILL.md`, hidden: true });
  const abs = u.parseBrowseState({ agent: 'openclaw-atlas', file: `${ROOT}/MEMORY.md`, hidden: null }, KNOWN);
  assert.deepEqual(abs, { agent: 'openclaw-atlas', file: `${ROOT}/MEMORY.md`, hidden: false });
});

await test('parseBrowseState: an unknown or malformed agent is ignored, and the file with it', () => {
  for (const agent of ['nope', '', null, undefined, 'agent_8ba21f83;ls', 'container-agent_8ba21f83']) {
    assert.deepEqual(u.parseBrowseState({ agent, file: 'a.md', hidden: '1' }, KNOWN), { agent: null, file: null, hidden: true });
  }
});

await test('parseBrowseState: a file outside the workspace root, empty or the root itself is ignored', () => {
  for (const file of ['../etc/passwd', '/etc/passwd', `${ROOT}/../x`, '/root/.openclaw/workspace-evil/x', '', null, undefined, `${ROOT}`, '.', 'a/../..', 'a\0b']) {
    assert.equal(u.parseBrowseState({ agent: 'agent_8ba21f83', file }, KNOWN).file, null, String(file));
  }
  // The agent stays valid when only the file is bad.
  assert.equal(u.parseBrowseState({ agent: 'agent_8ba21f83', file: '../x' }, KNOWN).agent, 'agent_8ba21f83');
  assert.equal(u.parseBrowseState({ agent: 'agent_8ba21f83', file: 'a/../b.md' }, KNOWN).file, `${ROOT}/b.md`);
});

await test('parseBrowseState: hidden is on only for exactly 1', () => {
  for (const [v, want] of [['1', true], ['0', false], ['true', false], ['', false], [null, false], [undefined, false], ['11', false]]) {
    assert.equal(u.parseBrowseState({ agent: null, hidden: v }, KNOWN).hidden, want, String(v));
  }
});

await test('confineToRoot agrees with checkPath', () => {
  for (const p of ['a.md', 'a/b/../c', `${ROOT}/x`, '../x', '/etc', '/', ROOT, `${ROOT}/`, '', 'a//b', './a', 'x\0', `${ROOT}/..`, '/root/.openclaw/workspace-evil']) {
    const want = m.checkPath(p);
    assert.equal(u.confineToRoot(p), want.ok ? want.path : null, JSON.stringify(p));
  }
});

await test('buildBrowseQuery and ancestorDirs', () => {
  assert.equal(u.buildBrowseQuery({}), '');
  assert.equal(u.buildBrowseQuery({ agent: 'agent_1' }), '?agent=agent_1');
  assert.equal(u.buildBrowseQuery({ agent: 'agent_1', file: `${ROOT}/a b/c&d.md`, hidden: true }), '?agent=agent_1&file=a+b%2Fc%26d.md&hidden=1');
  assert.equal(u.buildBrowseQuery({ file: `${ROOT}/a.md` }), '', 'a file without an agent is not written');
  assert.equal(u.buildBrowseQuery({ agent: 'agent_1', hidden: false }), '?agent=agent_1');
  // What is written is read back as the same state.
  const q = new URLSearchParams(u.buildBrowseQuery({ agent: 'agent_8ba21f83', file: `${ROOT}/x y/z.md`, hidden: true }));
  const back = u.parseBrowseState({ agent: q.get('agent'), file: q.get('file'), hidden: q.get('hidden') }, KNOWN);
  assert.deepEqual(back, { agent: 'agent_8ba21f83', file: `${ROOT}/x y/z.md`, hidden: true });
  assert.deepEqual(u.ancestorDirs(`${ROOT}/a.md`), []);
  assert.deepEqual(u.ancestorDirs(`${ROOT}/skills/a/b/SKILL.md`), ['skills', 'skills/a', 'skills/a/b']);
  assert.deepEqual(u.ancestorDirs('/etc/passwd'), []);
});

await test('LIST_SCRIPT: a missing or unreadable folder fails with a message mapExecError understands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-list-guard-'));
  try {
    const missing = m.listArgv(path.join(dir, 'gone'));
    const r = spawnSync(missing[0], missing.slice(1), { encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /No such file or directory/);
    assert.equal(m.mapExecError(new Error(`docker exec c: Command failed — ${r.stderr}`), 'x').status, 404);
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const notDir = m.listArgv(file);
    assert.equal(spawnSync(notDir[0], notDir.slice(1), { encoding: 'utf8' }).status, 4);
    if (process.getuid && process.getuid() !== 0) {
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0);
      const lk = m.listArgv(locked);
      const r2 = spawnSync(lk[0], lk.slice(1), { encoding: 'utf8' });
      fs.chmodSync(locked, 0o700);
      assert.equal(r2.status, 5);
      assert.match(r2.stderr, /Permission denied/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('visibleExpanded keeps only expanded folders whose ancestors are all expanded', () => {
  assert.deepEqual(u.visibleExpanded([]), []);
  assert.deepEqual(u.visibleExpanded(['a', 'a/b', 'c/d', 'a/b/e', 'x/y/z']), ['a', 'a/b', 'a/b/e']);
  assert.deepEqual(u.visibleExpanded(new Set(['a/b', 'a'])), ['a', 'a/b'], 'parents come first');
  assert.deepEqual(u.visibleExpanded(['', 'a']), ['a']);
});

await test('restoreTarget: a pending file is only for its own agent', () => {
  const pending = { workspace: 'container-a', file: `${ROOT}/x.md` };
  assert.equal(u.restoreTarget(pending, 'container-a'), `${ROOT}/x.md`);
  assert.equal(u.restoreTarget(pending, 'container-b'), null, 'after a switch it is dropped');
  assert.equal(u.restoreTarget(null, 'container-a'), null);
  assert.equal(u.restoreTarget(pending, ''), null);
});

// ── A real folder, where find is GNU ─────────────────────────────────────────

const gnu = spawnSync('find', ['/', '-maxdepth', '0', '-printf', 'x']);
if (gnu.status === 0 && String(gnu.stdout) === 'x') {
  await test('listArgv against a real folder (GNU find)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-list-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub dir'));
      fs.writeFileSync(path.join(dir, 'a|b.txt'), 'hello');
      fs.writeFileSync(path.join(dir, 'nl\nname.md'), '');
      fs.writeFileSync(path.join(dir, '.hidden'), 'x');
      fs.writeFileSync(path.join(dir, 'sub dir', 'inner.md'), 'x');
      const argv = m.listArgv(dir);
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
      assert.equal(r.status, 0);
      const names = m.parseList(r.stdout, ROOT, { hidden: true }).entries.map((e) => e.name);
      assert.deepEqual(names, ['sub dir', '.hidden', 'a|b.txt', 'nl\nname.md']);
      assert.deepEqual(m.parseList(r.stdout, ROOT).entries.map((e) => e.name), ['sub dir', 'a|b.txt', 'nl\nname.md']);
      // A missing folder fails (exit 4), it is not an empty answer.
      const gone = m.listArgv(path.join(dir, 'missing'));
      const r2 = spawnSync(gone[0], gone.slice(1), { encoding: 'utf8' });
      assert.equal(r2.status, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  console.log('skip - listArgv against a real folder (find has no GNU -printf here)');
}

console.log(`\n${passed} tests passed`);
