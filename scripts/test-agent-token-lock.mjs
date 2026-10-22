#!/usr/bin/env node
/**
 * Token lock, token file mode repair and the lineage fit key (FIX-129).
 *
 *   node scripts/test-agent-token-lock.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const ROOT = ${JSON.stringify(root)};
function withExt(p) {
  for (const e of ['', '.ts', '.js', '/index.ts']) if (existsSync(p + e) && !(e === '' && !/\\.\\w+$/.test(p))) return p + e;
  return null;
}
export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith('@/')) base = ROOT + '/' + specifier.slice(2);
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) base = new URL(specifier, context.parentURL).pathname;
  if (base) { const hit = withExt(base); if (hit) return next(pathToFileURL(hit).href, context); }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(root + '/'));


const { acquireTokenLock, withTokenLock } = await import('../lib/agent-token-lock.ts');
const tok = await import('../lib/agent-token.ts');
const { topologyFitKey } = await import('../lib/patterns/sessionPresentation.ts');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, statSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await test('two concurrent saves end on the last token everywhere', async () => {
  let file = '';
  const containers = { a: '', b: '' };
  const save = (token, latency) => withTokenLock(async () => {
    file = token;
    for (const c of Object.keys(containers)) { await sleep(latency); containers[c] = token; }
  });
  // A is slow and starts first; B is fast and starts second.
  await Promise.all([save('A', 30), (async () => { await sleep(5); await save('B', 1); })()]);
  assert.equal(file, 'B');
  assert.deepEqual(containers, { a: 'B', b: 'B' });
});

await test('a create holding the lock delays a save', async () => {
  const order = [];
  const release = await acquireTokenLock();
  const save = withTokenLock(async () => { order.push('save'); });
  await sleep(20);
  order.push('create-done');
  release();
  release(); // idempotent
  await save;
  assert.deepEqual(order, ['create-done', 'save']);
});

await test('a failing holder still releases the lock', async () => {
  await assert.rejects(withTokenLock(async () => { throw new Error('x'); }));
  assert.equal(await withTokenLock(async () => 'ok'), 'ok');
});

await test('lock is shared through globalThis', async () => {
  assert.ok(globalThis[Symbol.for('rev4a.agentTokenLock')]);
});

const dir = mkdtempSync(path.join(os.tmpdir(), 'rev4a-tokmode-'));
const runScript = (file) => execFileSync('sh', ['-c', tok.TOKEN_MODE_REPAIR_SCRIPT.replaceAll('/root/.agent-token', file)
  // BSD stat (macOS) has no -c; the container's stat is GNU.
  .replace('stat -c %a', process.platform === 'linux' ? 'stat -c %a' : 'stat -f %Lp')], { encoding: 'utf8' }).trim();
const mode = (file) => (statSync(file).mode & 0o777).toString(8);

await test('repair script: 644 becomes 600 and reports changed', () => {
  const f = path.join(dir, 't1'); writeFileSync(f, 'x\n'); chmodSync(f, 0o644);
  assert.equal(runScript(f), 'changed');
  assert.equal(mode(f), '600');
});
await test('repair script: already 600 changes nothing', () => {
  const f = path.join(dir, 't2'); writeFileSync(f, 'x\n'); chmodSync(f, 0o600);
  assert.equal(runScript(f), '');
  assert.equal(mode(f), '600');
});
await test('repair script: never loosens a stricter mode (400 stays 400)', () => {
  const f = path.join(dir, 't400'); writeFileSync(f, 'x\n'); chmodSync(f, 0o400);
  assert.equal(runScript(f), '');
  assert.equal(mode(f), '400');
});
await test('repair script: 640 loses only the group bits', () => {
  const f = path.join(dir, 't640'); writeFileSync(f, 'x\n'); chmodSync(f, 0o640);
  assert.equal(runScript(f), 'changed');
  assert.equal(mode(f), '600');
});
await test('repair script: missing file does nothing', () => {
  const f = path.join(dir, 'nope');
  assert.equal(runScript(f), '');
  assert.ok(!existsSync(f));
});
await test('repair script: a symlink is left untouched', () => {
  const target = path.join(dir, 'target'); writeFileSync(target, 'x'); chmodSync(target, 0o644);
  const link = path.join(dir, 'link'); symlinkSync(target, link);
  assert.equal(runScript(link), '');
  assert.equal(mode(target), '644');
});
rmSync(dir, { recursive: true, force: true });

await test('repairAllTokenFileModes counts the changed ones and survives a failure', async () => {
  const exec = async (c) => { if (c === 'bad') throw new Error('gone'); return c === 'a' ? 'changed\n' : ''; };
  assert.equal(await tok.repairAllTokenFileModes(async () => ['a', 'bad', 'b'], exec), 1);
});

const node = (uid, children = [], extra = {}) => ({ uid, name: uid, state: 'idle', children, ...extra });
await test('fit key ignores cost and state, follows structure and filter', () => {
  const t1 = node('__root__', [node('c', [node('s1', [], { cost_usd: 1, state: 'running' })])]);
  const t2 = node('__root__', [node('c', [node('s1', [], { cost_usd: 9, state: 'done', model: 'm' })])]);
  const t3 = node('__root__', [node('c', [node('s1'), node('s2')])]);
  assert.equal(topologyFitKey('all', t1), topologyFitKey('all', t2));
  assert.notEqual(topologyFitKey('all', t1), topologyFitKey('all', t3));
  assert.notEqual(topologyFitKey('all', t1), topologyFitKey('x', t1));
  const moved = node('__root__', [node('c', [node('s0', [node('s1')])])]);
  assert.notEqual(topologyFitKey('all', t1), topologyFitKey('all', moved));
});

console.log(`\n${passed} passed`);
