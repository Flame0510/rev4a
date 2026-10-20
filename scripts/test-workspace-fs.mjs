#!/usr/bin/env node
/**
 * Tests for lib/workspace-fs.ts: workspace ids, path confinement, the argv builders, the
 * save script (run with the local `sh` against a temp dir), the parsers and the read-only
 * mount check. No Docker, no network.
 *
 *   node scripts/test-workspace-fs.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import('../lib/workspace-fs.ts');

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

await test('parseWorkspaceId accepts container names only', () => {
  assert.equal(m.parseWorkspaceId('container-agent_8ba21f83'), 'agent_8ba21f83');
  assert.equal(m.parseWorkspaceId('container-openclaw-atlas'), 'openclaw-atlas');
  for (const bad of ['container-x;touch /tmp/p', 'container--help', 'local', 'container-', 'container-a b', 'container-$(id)', 'container-a\nb', '', 'vps', null, undefined, 5]) {
    assert.equal(m.parseWorkspaceId(bad), null, String(bad));
  }
});

await test('confinePath keeps paths inside the root', () => {
  assert.equal(m.confinePath(ROOT), ROOT);
  assert.equal(m.confinePath(ROOT + '/'), ROOT);
  assert.equal(m.confinePath(`${ROOT}/a/b.md`), `${ROOT}/a/b.md`);
  assert.equal(m.confinePath('SOUL.md'), `${ROOT}/SOUL.md`, 'relative is read against the root');
  assert.equal(m.confinePath(`${ROOT}/a/../b`), `${ROOT}/b`);
});

await test('confinePath refuses everything outside', () => {
  for (const bad of [
    `${ROOT}/..`,
    `${ROOT}/../../etc/passwd`,
    '../etc/passwd',
    '/root/.openclaw/workspace-evil/x',
    '/root/.openclaw/workspace-evil',
    '/etc/hostname',
    '/',
    '/root/.openclaw',
  ]) {
    assert.equal(m.confinePath(bad), null, bad);
    const r = m.checkPath(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403, bad);
  }
});

await test('checkPath: not a string, empty or NUL is 400', () => {
  for (const bad of [undefined, null, 5, {}, '', `${ROOT}/a\0b`]) {
    const r = m.checkPath(bad);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
});

await test('odd characters survive confinement as plain text', () => {
  for (const name of ["a $(touch x).md", "it's.md", 'with space.md', 'line\nbreak.md', '`id`.md', 'a;b|c.md']) {
    assert.equal(m.confinePath(`${ROOT}/${name}`), `${ROOT}/${name}`);
  }
});

await test('argv builders keep a nasty path as one element and never hold the content', () => {
  const nasty = `${ROOT}/a $(touch /tmp/pwn) 'q' "d"\nx;rm -rf.md`;
  for (const argv of [m.realpathArgv(nasty), m.statArgv(nasty), m.readArgv(nasty), m.treeArgv(nasty), m.dirListArgv(nasty), m.listArgv(nasty), m.writeArgv(nasty)]) {
    assert.ok(Array.isArray(argv));
    assert.equal(argv.filter((a) => a === nasty).length, 1, JSON.stringify(argv));
    for (const a of argv) if (a !== nasty) assert.ok(!a.includes('pwn'), a);
  }
  // The script text is constant: it does not depend on the path.
  assert.equal(m.writeArgv(nasty)[2], m.writeArgv('/x')[2]);
  assert.equal(m.writeArgv('/x')[2], m.WRITE_SCRIPT);
  assert.equal(m.writeArgv(nasty)[3], 'sh');
  assert.deepEqual(m.readArgv('-rf'), ['base64', '-w0', '--', '-rf']);
  assert.equal(m.decodeReadOutput(Buffer.from('h\u00e9llo\r\nno newline').toString('base64')), 'h\u00e9llo\r\nno newline');
  assert.equal(m.decodeReadOutput(Buffer.from('\ufeffbom').toString('base64')), '\ufeffbom');
  assert.equal(m.decodeReadOutput(Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64')), null, 'latin1 is not UTF-8');
  assert.equal(m.decodeReadOutput(''), '');
  assert.deepEqual(m.realpathArgv('-x'), ['realpath', '-m', '--', '-x']);
});

await test('treeArgv is the find the old listing ran, as arguments of a constant script', () => {
  assert.deepEqual(m.treeArgv(ROOT), [
    'sh', '-c', m.TREE_SCRIPT, 'sh', ROOT, '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.next', '-o', '-name', '.trash', '-o', '-name', 'cache', ')',
    '-prune', '-o', '-mindepth', '1', '-printf', '%P|%y|%s|%T@\\0',
  ]);
});

await test('the tree script keeps going: a missing root is an empty tree, not an error', () => {
  const r = spawnSync('sh', ['-c', m.TREE_SCRIPT, 'sh', '/nonexistent-ws-root-' + process.pid, '-name', 'x']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0);
});

await test('the save script refuses a fifo, and a new file gets 0644', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fs-'));
  try {
    const fifo = path.join(tmp, 'pipe');
    spawnSync('mkfifo', [fifo]);
    const r = spawnSync('sh', m.writeArgv(fifo).slice(1), { input: 'x', timeout: 5000 });
    assert.equal(r.status, m.WRITE_EXIT_NOT_FILE);
    const fresh = path.join(tmp, 'sub', 'new.md');
    const w = spawnSync('sh', m.writeArgv(fresh).slice(1), { input: 'hello' });
    assert.equal(w.status, 0, String(w.stderr));
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'sub')), ['new.md'], 'no temp file left');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('the save script: prints the new mtime, and a refused save creates nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fs-'));
  try {
    // BSD stat (macOS) has no `-c`: a shim on PATH gives the script the GNU `stat -c %Y -- file` it runs in the containers.
    const env = { ...process.env };
    if (spawnSync('stat', ['-c', '%Y', '--', tmp]).status !== 0) {
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\nshift 3\nexec /usr/bin/stat -f %m "$1"\n', { mode: 0o755 });
      env.PATH = bin + path.delimiter + process.env.PATH;
    }
    const run = (target, content, expected) => spawnSync('sh', m.writeArgv(target, expected).slice(1), { input: content, env });
    const file = path.join(tmp, 'a.md');
    fs.writeFileSync(file, 'old');
    const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000);
    const ok = run(file, 'new', seconds);
    assert.equal(ok.status, 0, String(ok.stderr));
    const lines = String(ok.stdout).split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one stdout line');
    assert.equal(Number(lines[0]), Math.floor(fs.statSync(file).mtimeMs / 1000));
    // Another mtime: refused, file untouched.
    const bad = run(file, 'x', seconds - 100);
    assert.equal(bad.status, m.WRITE_EXIT_CONFLICT);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    // The agent deleted the folder: refused, and the folder is not re-created.
    const gone = path.join(tmp, 'deleted-dir', 'b.md');
    const del = run(gone, 'x', 1000);
    assert.equal(del.status, m.WRITE_EXIT_CONFLICT);
    assert.ok(!fs.existsSync(path.join(tmp, 'deleted-dir')), 'no folder created');
    // No expected mtime: a new file in a new folder is still created.
    assert.equal(run(gone, 'x').status, 0);
    assert.ok(fs.existsSync(gone));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('the save script writes the bytes exactly, runs nothing, keeps the mode', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fs-'));
  try {
    const run = (target, content) => spawnSync('sh', m.writeArgv(target).slice(1), { input: Buffer.from(content, 'utf8') });
    const marker = path.join(tmp, 'PWNED');
    const cases = {
      heredoc: 'before\nEOFINNER\nafter\nEOFINNER',
      subst: `$(touch ${marker})\n\`touch ${marker}\`\n\${HOME}`,
      noNewline: 'no trailing newline',
      crlf: 'a\r\nb\r\n',
      empty: '',
      quotes: `it's "q"\n'`,
      unicode: 'caffè ☕ 日本語\n',
      trailingBlank: 'x\n\n\n',
    };
    for (const [name, content] of Object.entries(cases)) {
      const target = path.join(tmp, 'sub dir', `f $(touch ${marker}) ${name}.md`);
      const r = run(target, content);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(fs.readFileSync(target, 'utf8'), content, name);
      // Rewrite: still exact, and no temp file is left behind.
      assert.equal(run(target, content + 'more').status, 0);
      assert.equal(fs.readFileSync(target, 'utf8'), content + 'more');
    }
    assert.ok(!fs.existsSync(marker), 'nothing was executed');
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'sub dir')).filter((n) => n.startsWith('.rev4a-save')), []);

    // The mode of an existing file is kept; a new file is readable.
    const exe = path.join(tmp, 'run.sh');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o750);
    assert.equal(run(exe, '#!/bin/sh\necho hi').status, 0);
    assert.equal(fs.statSync(exe).mode & 0o777, 0o750);

    // A directory is refused with the documented code and left alone.
    const dir = path.join(tmp, 'adir');
    fs.mkdirSync(dir);
    const d = run(dir, 'x');
    assert.equal(d.status, m.WRITE_EXIT_IS_DIR);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.deepEqual(fs.readdirSync(dir), []);

    // A failed write leaves the old file whole.
    const keep = path.join(tmp, 'keep.md');
    fs.writeFileSync(keep, 'old');
    const failing = spawnSync('sh', ['-c', 'cat >/dev/null; exit 1', 'sh'], { input: 'x' });
    assert.equal(failing.status, 1);
    assert.equal(fs.readFileSync(keep, 'utf8'), 'old');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('parseStat', () => {
  assert.deepEqual(m.parseStat('regular file|120\n'), { kind: 'file', size: 120 });
  assert.deepEqual(m.parseStat('regular empty file|0\n'), { kind: 'file', size: 0 });
  assert.deepEqual(m.parseStat('directory|4096\n'), { kind: 'directory', size: 4096 });
  assert.equal(m.parseStat('fifo|0\n').kind, 'other');
  assert.equal(m.parseStat('garbage'), null);
});

await test('parseStat reads the mtime (whole seconds) when there is one', () => {
  assert.deepEqual(m.parseStat('regular file|120|1750000000\n'), { kind: 'file', size: 120, mtimeMs: 1750000000000 });
  assert.deepEqual(m.parseStat('directory|4096|1750000001'), { kind: 'directory', size: 4096, mtimeMs: 1750000001000 });
  assert.equal(m.parseStat('regular file|1|abc'), null);
  assert.deepEqual(m.statArgv('/x'), ['stat', '-c', '%F|%s|%Y', '--', '/x']);
});

await test('parseTree marks the entries under a read-only path', () => {
  const out = ['sub|d|4096|1.0', 'sub/a.md|f|3|1.0', 'subway.md|f|3|1.0', 'other.md|f|1|1.0'].join('\0') + '\0';
  const e = m.parseTree(out, ROOT, [ROOT + '/sub']);
  const ro = e.filter((x) => x.readOnly).map((x) => x.relPath).sort();
  assert.deepEqual(ro, ['sub', 'sub/a.md']);
  assert.ok(!('readOnly' in e.find((x) => x.relPath === 'other.md')), 'no readOnly key on a writable entry');
  assert.ok(m.parseTree(out, ROOT).every((x) => !('readOnly' in x)));
});

await test('parseTree: names, hidden top-level entries, a pipe in a name, sorting', () => {
  const out = [
    'b.md|f|10|1750000000.5000000000',
    'zdir|d|4096|1750000001.0',
    'zdir/inner.md|f|7|1750000002.0',
    'adir|d|4096|1750000003.0',
    '.rev4a|d|4096|1750000004.0',
    '.rev4a/AGENTS.md|f|3|1750000004.0',
    'odd|name.md|f|5|1750000005.0',
  ].join('\0') + '\0';
  const e = m.parseTree(out, ROOT);
  assert.deepEqual(e.map((x) => x.relPath), ['adir', 'zdir', 'zdir/inner.md', 'b.md', 'odd|name.md']);
  const odd = e.find((x) => x.relPath === 'odd|name.md');
  assert.equal(odd.name, 'odd|name.md');
  assert.equal(odd.size, 5);
  assert.equal(odd.path, `${ROOT}/odd|name.md`);
  assert.equal(e[0].isDirectory, true);
  assert.equal(e[0].size, 0);
  assert.equal(e.find((x) => x.relPath === 'b.md').mtimeMs, 1750000000500);
});

await test('parseDirList hides dotfiles and pruned directories', () => {
  const out = 'd|skills\0f|SOUL.md\0f|.env\0d|node_modules\0d|cache\0';
  assert.deepEqual(m.parseDirList(out), [
    { name: 'skills', isDirectory: true, isFile: false },
    { name: 'SOUL.md', isDirectory: false, isFile: true },
  ]);
});

await test('parseDirList sorts folders first, then by name', () => {
  const out = 'f|zeta.md\0d|skills\0f|Alpha.md\0d|memory\0';
  assert.deepEqual(m.parseDirList(out).map((e) => e.name), ['memory', 'skills', 'Alpha.md', 'zeta.md']);
});

await test('parseAgentPs lists running and stopped agent containers', () => {
  const rows = m.parseAgentPs('agent_8ba21f83|atlas|running\nagent_c0ffee00|ops|exited\nbad name|x|running\n|y|running\nno-label||running\n');
  assert.deepEqual(rows, [
    { name: 'agent_8ba21f83', agentId: 'atlas', running: true },
    { name: 'agent_c0ffee00', agentId: 'ops', running: false },
  ]);
});

await test('read-only mounts come from docker inspect and block saves under them', () => {
  const sample = JSON.stringify([
    { Type: 'bind', Source: '/h/rules', Destination: '/root/.openclaw/workspace/.rev4a', Mode: 'ro', RW: false, Propagation: 'rprivate' },
    { Type: 'bind', Source: '/h/skills', Destination: '/data/.openclaw/shared-skills', Mode: 'ro', RW: false },
    { Type: 'volume', Name: 'data', Destination: '/data', Mode: 'z', RW: true },
  ]);
  const ro = m.readOnlyMountDestinations(sample);
  assert.deepEqual(ro, ['/root/.openclaw/workspace/.rev4a', '/data/.openclaw/shared-skills']);
  assert.equal(m.isInReadOnlyMount(`${ROOT}/.rev4a/AGENTS.md`, ro), true);
  assert.equal(m.isInReadOnlyMount(`${ROOT}/.rev4a`, ro), true);
  assert.equal(m.isInReadOnlyMount(`${ROOT}/.rev4a-notes.md`, ro), false, 'sibling prefix');
  assert.equal(m.isInReadOnlyMount(`${ROOT}/SOUL.md`, ro), false);
  assert.deepEqual(m.readOnlyMountDestinations('not json'), []);
  assert.deepEqual(m.readOnlyMountDestinations('null'), []);
});

await test('mapExecError maps the failures to statuses', () => {
  const e = (msg) => new Error(msg);
  assert.deepEqual(m.mapExecError(e("docker exec c: exit 1 — stat: cannot statx '/x': No such file or directory"), 'Atlas'), { status: 404, error: 'File not found' });
  assert.equal(m.mapExecError(e('docker exec c: exit 1 — Error response from daemon: container abc is not running'), 'Atlas').error, 'Agent Atlas is not running');
  assert.equal(m.mapExecError(e('docker exec c: timed out'), 'Atlas').status, 502);
  assert.equal(m.mapExecError(e('Docker is not available'), 'Atlas').status, 503);
  assert.equal(m.mapExecError(e('boom'), 'Atlas').status, 500);
});

await test('limits and sizes', () => {
  assert.equal(m.MAX_READ_BYTES, 2 * 1024 * 1024);
  assert.equal(m.WORKSPACE_ROOT, ROOT);
  assert.equal(m.formatBytes(3 * 1024 * 1024 + 1), '3.0 MB');
  assert.equal(m.formatBytes(2048), '2 KB');
});

console.log(`\n${passed} passed`);
