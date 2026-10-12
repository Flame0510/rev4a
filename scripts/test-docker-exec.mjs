#!/usr/bin/env node
/**
 * Tests for lib/docker-exec.ts (the in-container timeout wrapper) and the Vercel whoami parser in
 * lib/credentials/detect.ts.
 *
 *   node scripts/test-docker-exec.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// The modules import through the `@/` alias and extensionless relative paths, as Next resolves
// them; a small resolve hook gives plain Node the same view.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const ROOT = ${JSON.stringify(root)};
function withExt(p) {
  for (const e of ['', '.ts', '.js', '/index.ts']) if (existsSync(p + e) && !(e === '' && !/\\.\\w+$/.test(p))) return p + e;
  return null;
}
export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith('@/')) base = ROOT + '/' + specifier.slice(2);
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    base = new URL(specifier, context.parentURL).pathname;
  }
  if (base) {
    const hit = withExt(base);
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(root + '/'));

const d = await import('../lib/exec-timeout.js');
const det = await import('../lib/credentials/detect.ts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

test('argv builder wraps the command in timeout -k 5 N', () => {
  assert.deepEqual(
    d.buildExecArgs({ container: 'c1', argv: ['openclaw', 'devices', 'list', '--json'], timeoutMs: 20_000, wrap: true }),
    ['exec', 'c1', 'timeout', '-k', '5', '20', 'openclaw', 'devices', 'list', '--json'],
  );
});

test('seconds are rounded up, never below one', () => {
  assert.equal(d.timeoutSeconds(20_000), 20);
  assert.equal(d.timeoutSeconds(20_001), 21);
  assert.equal(d.timeoutSeconds(1), 1);
  assert.equal(d.timeoutSeconds(0), 1);
  assert.equal(d.timeoutSeconds(14_500), 15);
});

test('the client timer outlasts the in-container deadline and its kill-after', () => {
  assert.ok(d.clientTimeoutMs(20_000) >= 20_000 + 5_000);
  assert.ok(d.clientTimeoutMs(500) > 1_000 + 5_000);
});

test('env goes by name only, -i comes first, argv entries stay single arguments', () => {
  const args = d.buildExecArgs({
    container: 'c1', argv: ['sh', '-c', 'echo "$X" && rm -rf /'], envKeys: ['TOKEN_A', 'TOKEN_B'],
    interactive: true, timeoutMs: 5_000, wrap: true,
  });
  assert.deepEqual(args, [
    'exec', '-i', '-e', 'TOKEN_A', '-e', 'TOKEN_B', 'c1',
    'timeout', '-k', '5', '5', 'sh', '-c', 'echo "$X" && rm -rf /',
  ]);
  assert.ok(!args.slice(0, -1).some((a) => a.includes('=') && a !== '-k', '5'), 'no KEY=VALUE before the command');
});

test('the wrapper adds nothing but timeout, its option and the number', () => {
  const base = d.buildExecArgs({ container: 'c', argv: ['a', 'b'], timeoutMs: 1000, wrap: false });
  const wrapped = d.buildExecArgs({ container: 'c', argv: ['a', 'b'], timeoutMs: 1000, wrap: true });
  assert.deepEqual(base, ['exec', 'c', 'a', 'b']);
  assert.deepEqual(wrapped, ['exec', 'c', 'timeout', '-k', '5', '1', 'a', 'b']);
});

test('no wrap leaves the argv as before', () => {
  assert.deepEqual(d.buildExecArgs({ container: 'c', argv: ['echo', 'hi'], timeoutMs: 9_000, wrap: false }), ['exec', 'c', 'echo', 'hi']);
});

test('exit 124 and 137 are the timeout exits', () => {
  assert.equal(d.isTimeoutExit(124), true);
  assert.equal(d.isTimeoutExit(137), true);
  for (const c of [0, 1, 2, 126, 127, 143, undefined, null, '124']) assert.equal(d.isTimeoutExit(c), false);
});

test('the wrapper is unusable: real messages, stdout or stderr', () => {
  const oci = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "timeout": executable file not found in $PATH: unknown';
  // Docker Desktop 29.1.3 prints it on STDOUT, exit 127; the callers pass stdout + stderr joined.
  assert.equal(d.isWrapperMissing(127, oci + '\n'), true);
  assert.equal(d.isWrapperMissing(127, '\n' + oci), true);
  assert.equal(d.isWrapperMissing(126, oci), true);
  assert.equal(d.isWrapperMissing(125, oci), true);
  assert.equal(d.isWrapperMissing(127, 'sh: 1: timeout: not found'), true);
  // busybox without -k
  assert.equal(d.isWrapperMissing(1, 'timeout: unrecognized option: k\nBusyBox v1.35.0 multi-call binary.\n\nUsage: timeout [-s SIG] SECS PROG ARGS'), true);
  assert.equal(d.isWrapperMissing(1, 'timeout: invalid option -- k\nUsage: timeout [-s SIG] SECS PROG ARGS'), true);
  // the wrapped command failing is not the wrapper failing
  assert.equal(d.isWrapperMissing(127, "timeout: failed to run command 'foo': No such file or directory"), false);
  assert.equal(d.isWrapperMissing(1, 'Error: something else'), false);
  assert.equal(d.isWrapperMissing(1, oci), false);
  assert.equal(d.isWrapperMissing(124, ''), false);
  assert.equal(d.isWrapperMissing(undefined, oci), false);
  assert.equal(d.isWrapperMissing(127, ''), false);
});

test('137 is worded as possibly killed, 124 as timed out', () => {
  assert.equal(d.timeoutCause(124), 'timed out');
  assert.equal(d.timeoutCause(137), 'timed out or was killed (exit 137)');
});

test('the unwrapped Set is shared and per container', () => {
  const s = d.unwrappedContainers();
  s.add('alpine-1');
  assert.equal(d.unwrappedContainers().has('alpine-1'), true);
  assert.equal(d.unwrappedContainers().has('other'), false);
  s.delete('alpine-1');
});

const LOGGED_OUT = '> Run `vercel deploy --temporary` to create a temporary deployment you can claim later, or `vercel login` to log in.';

test('vercel whoami: the real logged-out output is not a user', () => {
  assert.equal(det.parseVercelWhoami(`${LOGGED_OUT}\nrc=0`), '');
  assert.equal(det.parseVercelWhoami(`${LOGGED_OUT}\nrc=1`), '');
});

test('vercel whoami: ANSI codes are stripped before the checks', () => {
  assert.equal(det.parseVercelWhoami('\u001b[2K\u001b[1Gflame0510\nrc=0'), 'flame0510');
  assert.equal(det.parseVercelWhoami(`\u001b[33m${LOGGED_OUT}\u001b[39m\nrc=0`), '');
});

test('vercel whoami: a plain username with exit 0 is a user', () => {
  assert.equal(det.parseVercelWhoami('flame0510\nrc=0'), 'flame0510');
  assert.equal(det.parseVercelWhoami('some-user_1\r\nrc=0'), 'some-user_1');
});

test('vercel whoami: non-zero exit, errors, banners, multiple lines, empty and no status are not users', () => {
  assert.equal(det.parseVercelWhoami('flame0510\nrc=1'), '');
  assert.equal(det.parseVercelWhoami('Error: No existing credentials found.\nrc=1'), '');
  assert.equal(det.parseVercelWhoami('Error: nope\nrc=0'), '');
  assert.equal(det.parseVercelWhoami('Vercel CLI 50.1.0\nflame0510\nrc=0'), '');
  assert.equal(det.parseVercelWhoami('Vercel CLI 50.1.0\nrc=0'), '');
  assert.equal(det.parseVercelWhoami('\nrc=0'), '');
  assert.equal(det.parseVercelWhoami('rc=0'), '');
  assert.equal(det.parseVercelWhoami('flame0510'), '');
  assert.equal(det.parseVercelWhoami(''), '');
  assert.equal(det.parseVercelWhoami('two words\nrc=0'), '');
});

console.log(`\n${passed} passed`);
