#!/usr/bin/env node
/**
 * The gateway token never reaches argv or error text (SEC-10).
 *
 *   node scripts/test-agent-token-redaction.mjs
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

const { redactSecret, redactedMessage } = await import('../lib/redact-secret.ts');
const tok = await import('../lib/agent-token.ts');
const { buildCreateRunArgs } = await import('../lib/agent-create-args.ts');

const TOKEN = 'sEcr3t-t0ken/with\'quote';
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

test('redactSecret replaces every occurrence and env assignments', () => {
  const out = redactSecret(`Command failed: docker run -e OPENCLAW_GATEWAY_TOKEN=abc123 x ${TOKEN} y ${TOKEN}`, TOKEN);
  assert.ok(!out.includes(TOKEN) && !out.includes('abc123'));
  assert.ok(out.includes('OPENCLAW_GATEWAY_TOKEN=***'));
});

test('redactSecret with an empty secret leaves text alone', () => {
  assert.equal(redactSecret('plain error', ''), 'plain error');
  assert.equal(redactSecret('plain error', null), 'plain error');
});

test('redactedMessage handles Error and non-Error values', () => {
  assert.equal(redactedMessage(new Error(`boom ${TOKEN}`), TOKEN), 'boom ***');
  assert.equal(redactedMessage(`str ${TOKEN}`, TOKEN), 'str ***');
});

{
  const calls = [];
  await tok.writeTokenToContainer('agent_1', TOKEN, async (c, argv, input) => { calls.push({ c, argv, input }); return ''; });
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls[0].argv).includes(TOKEN));
  assert.equal(calls[0].input, `${TOKEN}\n`);
  assert.equal(calls[0].c, 'agent_1');
  passed++; console.log('ok   token write: argv has no token, the token goes on stdin');
}

test('restart argv is a plain docker argv', () => {
  assert.deepEqual(tok.restartArgv('agent_1'), ['restart', 'agent_1']);
});

test('create run argv carries no token', () => {
  const args = buildCreateRunArgs({
    containerName: 'agent_ab', network: 'rev4a-network', mountFlags: ['-v', 'a:/b:ro'], memoryBytes: 536870912,
    labels: ['AGENT_ID=agent_ab'], envVars: ['AGENT_ID=agent_ab', 'TZ=Europe/Rome'], portArgs: ['-p', '3700-3709:3000-3009'], image: 'img:1',
  });
  assert.equal(args[0], 'run');
  assert.ok(!args.join(' ').includes('OPENCLAW_GATEWAY_TOKEN'));
  assert.equal(args.at(-1), 'img:1');
  assert.ok(args.includes('--memory') && args.includes('--memory-swap'));
  const noMem = buildCreateRunArgs({ containerName: 'a', network: 'n', mountFlags: [], memoryBytes: null, labels: [], envVars: [], portArgs: [], image: 'i' });
  assert.ok(!noMem.includes('--memory'));
});

test('a secret shorter than 8 characters is not split on, the assignment still is', () => {
  assert.equal(redactSecret('the cat sat', 'at'), 'the cat sat');
  assert.equal(redactSecret('OPENCLAW_GATEWAY_TOKEN=abc x', 'abc'), 'OPENCLAW_GATEWAY_TOKEN=*** x');
  assert.equal(redactSecret('x 12345678 y', '12345678'), 'x *** y');
});
console.log(`\n${passed} passed`);
