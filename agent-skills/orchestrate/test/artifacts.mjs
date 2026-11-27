// Offline real-filesystem/process regressions; fixtures are owned by this test only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ARTIFACT_DEFAULTS, beginArtifacts, disposablePaths, endArtifacts, validatePolicy } from '../scripts/lib/artifacts.mjs';
import { setArtifactPolicy, sh } from '../scripts/lib/util.mjs';
import { sweepTemp } from '../scripts/lib/artifact-gc.mjs';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-artifact-test-')));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const policy = { enabled: true, root: path.join(base, 'artifacts'), minFreeBytes: 0, disposable: ['*/runtime/.next', '*/node_modules'] };
const add = (s, rel) => { const p = path.join(s.temp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'fixture'); return p; };
const receipt = s => JSON.parse(fs.readFileSync(path.join(s.scope, 'receipt.json')));
try {
  test('legacy policy leaves environment and directories alone', () => { assert.equal(beginArtifacts(ARTIFACT_DEFAULTS), null); });
  test('reject traversal, absolute paths and evidence targets', () => {
    for (const p of ['../node_modules', '/x/.next', 'x/../node_modules', 'x/reports', '**/node_modules']) assert.throws(() => validatePolicy({ ...policy, disposable: [p] }));
  });
  test('success removes declared builds and retains source, logs and receipts', () => {
    const s = beginArtifacts(policy); add(s, 'run/runtime/.next/cache'); const source = add(s, 'run/runtime/app/page.ts'); const log = add(s, 'run/server.log');
    endArtifacts(s, { code: 0, quiescent: true });
    assert(!fs.existsSync(path.join(s.temp, 'run/runtime/.next'))); assert(fs.existsSync(source)); assert(fs.existsSync(log)); assert.equal(receipt(s).removed.length, 1);
    endArtifacts(s, { code: 0, quiescent: true }); assert(fs.existsSync(source)); assert.equal(receipt(s).removed.length, 1);
  });
  test('failure, interruption and uncertain child lifecycle retain every build', () => {
    for (const result of [{ code: 1, quiescent: true }, { code: 0, quiescent: false }, { code: 0, quiescent: true, interrupted: true }]) {
      const s = beginArtifacts(policy); const p = add(s, 'run/runtime/.next/build'); endArtifacts(s, result); assert(fs.existsSync(p)); assert.equal(receipt(s).status, 'retained');
    }
  });
  test('shared node_modules symlink and intermediate links are never traversed', () => {
    const s = beginArtifacts(policy); const shared = path.join(base, 'shared'); fs.mkdirSync(path.join(shared, '.next'), { recursive: true }); fs.writeFileSync(path.join(shared, '.next/keep'), 'keep');
    fs.mkdirSync(path.join(s.temp, 'run')); fs.symlinkSync(shared, path.join(s.temp, 'run/node_modules')); fs.symlinkSync(shared, path.join(s.temp, 'run/runtime'));
    assert.deepEqual(disposablePaths(s.temp, policy.disposable), []); endArtifacts(s, { code: 0, quiescent: true }); assert(fs.existsSync(path.join(shared, '.next/keep')));
  });
  test('nested symlink inside deleted build does not affect target', () => {
    const s = beginArtifacts(policy); add(s, 'run/runtime/.next/cache'); fs.symlinkSync(path.join(base, 'shared'), path.join(s.temp, 'run/runtime/.next/shared'));
    endArtifacts(s, { code: 0, quiescent: true }); assert(fs.existsSync(path.join(base, 'shared/.next/keep')));
  });
  test('separate scopes cannot clean active or unrelated scopes', () => {
    const a = beginArtifacts(policy); const b = beginArtifacts(policy); const keep = add(a, 'run/runtime/.next/build'); add(b, 'run/runtime/.next/build'); endArtifacts(b, { code: 0, quiescent: true }); assert(fs.existsSync(keep));
  });
  test('free-space preflight refuses command without consuming code verdict', () => {
    setArtifactPolicy({ ...policy, minFreeBytes: Number.MAX_SAFE_INTEGER }); const r = sh('echo SHOULD_NOT_RUN', { cwd: base }); assert(r.infra); assert.equal(r.code, 125); assert(!r.out.includes('SHOULD_NOT_RUN'));
  });
  test('runner assigns unique TMPDIR and preserves failed command evidence', () => {
    setArtifactPolicy(policy); const r = sh(`node -e 'const fs=require("fs"),p=require("path"),os=require("os"); fs.mkdirSync(p.join(os.tmpdir(),"run/runtime/.next"),{recursive:true}); fs.writeFileSync(p.join(os.tmpdir(),"run/runtime/.next/build"),"build"); console.log(process.env.ORCH_ARTIFACTS_DIR); process.exit(7)'`, { cwd: base });
    assert.equal(r.code, 7); const scope = r.out.split('\n')[0]; assert(scope.startsWith(policy.root)); assert(fs.existsSync(path.join(scope, 'tmp/run/runtime/.next/build'))); assert.equal(receipt({ scope }).status, 'retained');
  });
  test('runner timeout retains artifacts and ends its owned process', () => {
    const r = sh(`node -e 'console.log(process.env.ORCH_ARTIFACTS_DIR);setInterval(()=>{},1000)'`, { cwd: base, timeoutSec: 1 }); assert.equal(r.code, 124); assert(r.timedOut); assert.equal(receipt({ scope: r.out.split('\n')[0] }).status, 'retained');
  });
  test('disabled runner keeps historical TMPDIR behaviour', () => {
    setArtifactPolicy(ARTIFACT_DEFAULTS); const r = sh(`node -e 'console.log(process.env.TMPDIR)'`, { cwd: base, env: { TMPDIR: base } }); assert.equal(r.code, 0); assert.equal(r.out.trim(), base);
  });
  test('production Linux runner cleans success and protects detached users', () => {
    if (process.platform !== 'linux') { console.log('Linux process assertions are exercised on the deployment host'); return; }
    setArtifactPolicy(policy);
    const command = `node -e 'const fs=require("fs"),p=require("path"),os=require("os");fs.mkdirSync(p.join(os.tmpdir(),"run/runtime/.next"),{recursive:true});console.log(process.env.ORCH_ARTIFACTS_DIR)'`;
    const r = sh(command, { cwd: base }); assert.equal(r.code, 0); const scope = r.out.split('\n')[0]; assert.equal(receipt({ scope }).status, 'complete'); assert(!fs.existsSync(path.join(scope, 'tmp/run/runtime/.next')));
    const escaped = sh(`node -e 'const c=require("child_process"); console.log(process.env.ORCH_ARTIFACTS_DIR); const p=c.spawn(process.execPath,["-e","setTimeout(()=>{},2000)"],{detached:true,stdio:"ignore"});p.unref()'`, { cwd: base });
    assert.equal(escaped.code, 0); assert.equal(receipt({ scope: escaped.out.split('\n')[0] }).status, 'retained');
    spawnSync('sleep', ['3']);
  });
  test('tmpSweep config is checked', () => {
    for (const t of [{ days: 2 }, { days: 1, dir: '/var/tmp', keep: ['cache', 'jiti*'] }, null]) validatePolicy({ ...policy, tmpSweep: t });
    for (const t of [{}, { days: 0 }, { days: '2' }, { days: 2, dir: 'tmp' }, { days: 2, dir: '/' }, { days: 2, keep: ['a/b'] }, { days: 2, keep: ['*x'] }, { days: 2, extra: 1 }, [2], 2]) {
      assert.throws(() => validatePolicy({ ...policy, tmpSweep: t }), /tmpSweep/, JSON.stringify(t));
    }
  });
  test('the temporary folder sweep deletes only old, unused entries of this user', () => {
    const dir = path.join(base, 'systmp'); fs.mkdirSync(dir);
    const mk = (rel, file = 'x') => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, file); return p; };
    mk('old-dir/a/b.txt'); mk('old-file.log'); mk('.hidden-old/x'); mk('systemd-private-1/x'); mk('cache-keep/x'); mk('kept-prefix-1/x'); mk('busy/x');
    mk('recent/old.txt'); const later = (Date.now() + 5 * 86_400_000) / 1000; fs.utimesSync(mk('recent/new.txt'), later, later);
    fs.symlinkSync(path.join(base, 'shared'), path.join(dir, 'link-old'));
    // Everything created now is old for a clock 3 days ahead; recent/new.txt was modified "5 days from now".
    const args = { dir, days: 2, keep: ['cache-keep', 'kept-prefix*'], now: Date.now() + 3 * 86_400_000 };
    if (process.platform !== 'linux') { assert.deepEqual(sweepTemp({ ...args, apply: true }).entries, []); assert(fs.existsSync(path.join(dir, 'old-dir'))); return; }
    const child = spawn('sleep', ['30'], { cwd: path.join(dir, 'busy'), stdio: 'ignore' });
    spawnSync('sleep', ['0.3']);
    try {
      const plan = sweepTemp(args);
      assert.deepEqual(plan.entries.map(e => path.basename(e.path)).sort(), ['old-dir', 'old-file.log']); assert.equal(plan.deleted, 0);
      assert(fs.existsSync(path.join(dir, 'old-dir')));
      const r = sweepTemp({ ...args, apply: true, max: 1 }); assert.equal(r.deleted, 1);
      const r2 = sweepTemp({ ...args, apply: true }); assert.equal(r2.deleted, 1);
      for (const n of ['.hidden-old', 'systemd-private-1', 'cache-keep', 'kept-prefix-1', 'busy', 'recent', 'link-old']) assert(fs.existsSync(path.join(dir, n)) || fs.lstatSync(path.join(dir, n)), n);
      assert(!fs.existsSync(path.join(dir, 'old-dir')) && !fs.existsSync(path.join(dir, 'old-file.log')));
      assert(fs.existsSync(path.join(base, 'shared/.next/keep')), 'a link target is never touched');
      assert.equal(sweepTemp({ ...args, days: 0, apply: true }).deleted, 0, 'days below 1 sweeps nothing');
    } finally { child.kill(); }
  });
  test('the sweep spares sockets, protected folders and what another user\'s process uses', () => {
    if (process.platform !== 'linux') return;
    const dir = path.join(base, 'systmp2'); fs.mkdirSync(dir);
    for (const d of ['sockdir', 'repo-parent/repo', 'foreign', 'plain']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plain/f'), 'x');
    const args = { dir, days: 2, now: Date.now() + 3 * 86_400_000, protect: [path.join(dir, 'repo-parent/repo')] };
    // A live unix socket server in another process, whose working directory is elsewhere.
    const server = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path.join(dir, 'sockdir/s.sock'))}); setTimeout(() => {}, 30000)`], { cwd: '/', stdio: 'ignore' });
    let foreign = null;
    if (process.getuid() === 0) foreign = spawn('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'sleep', '30'], { cwd: path.join(dir, 'foreign'), stdio: 'ignore' });
    spawnSync('sleep', ['0.5']);
    try {
      const r = sweepTemp({ ...args, apply: true });
      for (const d of ['sockdir', 'repo-parent', 'foreign']) assert(fs.existsSync(path.join(dir, d)), `${d} kept`);
      // Either the foreign process was inspected (plain goes) or it could not be (nothing goes, and it says why).
      assert(r.blocked ? fs.existsSync(path.join(dir, 'plain')) : !fs.existsSync(path.join(dir, 'plain')), JSON.stringify(r));
      assert.match(sweepTemp({ ...args, dir: path.join(dir, 'repo-parent/repo'), protect: [path.join(dir, 'repo-parent')] }).blocked ?? '', /inside/, 'a dir inside a protected folder sweeps nothing');
    } finally { server.kill(); foreign?.kill(); }
  });
  console.log(`${passed} artifact regression groups passed`);
} finally { setArtifactPolicy(ARTIFACT_DEFAULTS); fs.rmSync(base, { recursive: true, force: true }); }
