// Offline real-filesystem/process regressions; fixtures are owned by this test only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARTIFACT_DEFAULTS, beginArtifacts, disposablePaths, endArtifacts, validatePolicy } from '../scripts/lib/artifacts.mjs';
import { setArtifactPolicy, sh } from '../scripts/lib/util.mjs';
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
  console.log(`${passed} artifact regression groups passed`);
} finally { setArtifactPolicy(ARTIFACT_DEFAULTS); fs.rmSync(base, { recursive: true, force: true }); }
