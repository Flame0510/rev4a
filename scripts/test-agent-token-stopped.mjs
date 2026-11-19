#!/usr/bin/env node
/**
 * Saving the agents token reaches stopped agents too (their volume file wins over the env at start,
 * and survives Recreate), never puts the token in argv, and reports busy or paused agents.
 *
 *   node scripts/test-agent-token-stopped.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const { writeTokenToStoppedContainer, readStoppedTokenEntry, repairStoppedAgentTokens, isValidAgentsToken } = await import('../lib/agent-token.ts');

// One tar entry as `docker cp <c>:<path> -` streams it: 512-byte header (size octal at 124, type at 156), body padded.
function tarEntry(type, body = '') {
  const header = Buffer.alloc(512);
  header.write('.agent-token', 0);
  header.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + '\0', 124);
  header.write(type, 156);
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body);
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}
const absent = async () => null;
const TOKEN = "s3cret-'tok\"en/with spaces";
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

await test('stopped container: staged file 0600 with the token, copied to /root/.agent-token, temp dir removed', async () => {
  const calls = [];
  await writeTokenToStoppedContainer('agent_x', TOKEN, async (src, dest) => {
    const st = fs.statSync(src);
    calls.push({ src, dest, mode: st.mode & 0o777, dirMode: fs.statSync(path.dirname(src)).mode & 0o777, body: fs.readFileSync(src, 'utf8') });
  }, absent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dest, 'agent_x:/root/.agent-token');
  assert.equal(calls[0].mode, 0o600);
  assert.equal(calls[0].dirMode, 0o700);
  assert.equal(calls[0].body, `${TOKEN}\n`);
  assert.ok(!calls[0].src.includes(TOKEN) && !calls[0].dest.includes(TOKEN), 'token never in argv');
  assert.equal(fs.existsSync(path.dirname(calls[0].src)), false, 'staging dir removed');
});

await test('a failed copy still removes the staging dir and rejects', async () => {
  let staged = '';
  await assert.rejects(writeTokenToStoppedContainer('agent_x', TOKEN, async (src) => { staged = src; throw new Error('No such container'); }, absent), /No such container/);
  assert.equal(fs.existsSync(path.dirname(staged)), false);
});

await test('route lists all agents (docker ps -a), handles stopped, paused and running separately', async () => {
  const src = fs.readFileSync(path.join(root, 'app/api/agents/token/route.ts'), 'utf8');
  assert.match(src, /\['ps', '-a', '--filter', 'label=AGENT_ID'/);
  assert.match(src, /state === 'paused'/);
  assert.match(src, /writeTokenToStoppedContainer\(name, token\)/);
  assert.match(src, /stoppedUpdated: stopped\.length/);
  assert.ok(src.indexOf("state === 'paused'") < src.indexOf('writeTokenToStoppedContainer(name, token)'));
  assert.ok(src.indexOf('writeTokenToStoppedContainer(name, token)') < src.indexOf('restartArgv(name)'), 'stopped agents are never restarted');
});

await test('reads what is at /root/.agent-token: absent, a file (first line), a directory or a symlink (other)', async () => {
  assert.deepEqual(await readStoppedTokenEntry('c', absent), { kind: 'absent' });
  assert.deepEqual(await readStoppedTokenEntry('c', async () => tarEntry('0', ' tok \nignored\n')), { kind: 'file', token: 'tok' });
  assert.deepEqual(await readStoppedTokenEntry('c', async () => tarEntry('0', '')), { kind: 'file', token: '' });
  assert.deepEqual(await readStoppedTokenEntry('c', async () => tarEntry('5')), { kind: 'other' });
  assert.deepEqual(await readStoppedTokenEntry('c', async () => tarEntry('2')), { kind: 'other' });
  await assert.rejects(readStoppedTokenEntry('c', async () => Buffer.alloc(10)), /Unreadable/);
});

await test('a directory or symlink in place of the file is refused and never copied onto', async () => {
  for (const type of ['5', '2']) {
    let copied = false;
    await assert.rejects(writeTokenToStoppedContainer('agent_x', TOKEN, async () => { copied = true; }, async () => tarEntry(type)), /not a regular file/);
    assert.equal(copied, false);
  }
});

await test('PAX and GNU long-name records before the entry are skipped', async () => {
  const pax = (body) => tarEntry('x', body).subarray(0, 512 + Math.ceil(Buffer.byteLength(body) / 512) * 512);
  assert.deepEqual(await readStoppedTokenEntry('c', async () => Buffer.concat([pax('30 mtime=1700000000.123456789\n'), tarEntry('0', 'tok\n')])), { kind: 'file', token: 'tok' });
  assert.deepEqual(await readStoppedTokenEntry('c', async () => Buffer.concat([pax('x'.repeat(700)), tarEntry('5')])), { kind: 'other' });
});

await test('token validator: hex from Generate passes; empty, spaces, controls, non-strings and over 4096 chars fail', () => {
  assert.equal(isValidAgentsToken('a'.repeat(48)), true);
  for (const bad of ['', 'a b', 'a\nb', 'a\tb', 'x'.repeat(4097), {}, 0, false, null, undefined]) assert.equal(isValidAgentsToken(bad), false, String(bad));
});

await test('startup repair: per agent, only stopped and idle agents not on the saved token; idempotent; failures isolated and redacted', async () => {
  const files = { same: tarEntry('0', `${TOKEN}\n`), old: tarEntry('0', 'OLD\n'), envOld: null, envSame: null, dir: tarEntry('5'), boom: tarEntry('0', 'OLD\n'),
    gone: null, started: tarEntry('0', 'OLD\n'), busy: tarEntry('0', 'OLD\n'), after: tarEntry('0', 'OLD\n') };
  const env = { same: 'X', old: TOKEN, envOld: 'OLD', envSame: TOKEN, dir: 'OLD', boom: 'OLD', started: 'OLD', busy: 'OLD', after: 'OLD' };
  const written = [];
  const warnings = [];
  const list = async () => Object.keys(files).map((name) => ({ name, agentId: name }));
  const deps = {
    isBusy: async (id) => id === 'busy',
    inspect: async (name) => {
      if (name === 'gone') throw new Error('No such container: gone');
      return { state: name === 'started' ? 'running' : 'exited', envToken: env[name] };
    },
    copyOut: async (src) => files[src.split(':')[0]],
    copy: async (src, dest) => {
      const name = dest.split(':')[0];
      if (name === 'boom') throw new Error(`copy failed for ${TOKEN}`);
      written.push(name);
      files[name] = tarEntry('0', fs.readFileSync(src, 'utf8'));
    },
    warn: (m) => warnings.push(m),
  };
  assert.deepEqual(await repairStoppedAgentTokens(TOKEN, list, deps), ['old', 'envOld', 'after'], 'a missing container does not stop the agents after it');
  assert.deepEqual(written, ['old', 'envOld', 'after']);
  assert.ok(warnings.some((w) => w.startsWith('dir:') && /not a regular file/.test(w)));
  assert.ok(warnings.some((w) => w.startsWith('boom:')) && warnings.some((w) => w.startsWith('gone:')));
  assert.ok(warnings.every((w) => !w.includes(TOKEN)), 'token never in a warning');
  written.length = 0;
  assert.deepEqual(await repairStoppedAgentTokens(TOKEN, list, deps), [], 'second run changes nothing');
  assert.deepEqual(await repairStoppedAgentTokens('', list, deps), [], 'no saved token: no-op');
});

await test('route: tab-separated listing, and an agent started during the write is handled as running', async () => {
  const src = fs.readFileSync(path.join(root, 'app/api/agents/token/route.ts'), 'utf8');
  assert.match(src, /\{\{\.Names\}\}\\t\{\{\.Label "AGENT_ID"\}\}\\t\{\{\.State\}\}/);
  assert.match(src, /line\.split\('\\t'\)/);
  const write = src.indexOf('writeTokenToStoppedContainer(name, token)');
  const recheck = src.indexOf("await currentState(name) !== 'running'");
  assert.ok(write > 0 && recheck > write && recheck < src.indexOf('stopped.push(name)'));
});

console.log(`${passed} passed`);
