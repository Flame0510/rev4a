#!/usr/bin/env node
/**
 * One command for every fast test: `npm test`.
 *
 * Discovers scripts/test-*.mjs and scripts/test-*.sh, runs each in its own process with a
 * timeout, prints one line per file and a summary, and exits non-zero when any file fails.
 * Needs no Docker, no network and no running instance.
 *
 *   node scripts/run-tests.mjs              run everything
 *   node scripts/run-tests.mjs envcheck     run only the files whose name contains "envcheck"
 *   node scripts/run-tests.mjs --ui         `npm run check:ui`: run every scripts/ui-check*.mjs against a
 *                                           running instance (needs REV4A_BASE_URL; never part of CI)
 *
 * Environment:
 *   REV4A_TEST_TIMEOUT_MS  per-file timeout (default 120000)
 *   REV4A_TEST_VERBOSE=1   print the output of passing files too
 *
 * A test that cannot run in CI goes in SKIP below, with the reason. Never skip silently.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.REV4A_TEST_TIMEOUT_MS) || (process.argv.includes('--ui') ? 300000 : 120000);
const VERBOSE = process.env.REV4A_TEST_VERBOSE === '1';

/** file name -> reason it does not run. Empty on purpose: every test runs today. */
const SKIP = {};

// Some tests import lib/*.ts directly. Type stripping is on by default from Node 22.18; older
// releases get the flag, which exists from Node 22.6. Below that the tests cannot run at all.
const [major, minor] = process.versions.node.split('.').map(Number);
if (!process.features?.typescript && (major < 22 || (major === 22 && minor < 6))) {
  console.error(`npm test needs Node 22.6 or later (this is ${process.versions.node}): some tests import TypeScript files.`);
  process.exit(1);
}
const NODE_FLAGS = process.features?.typescript ? ['--no-warnings'] : ['--experimental-strip-types', '--no-warnings'];

const args = process.argv.slice(2);
const UI = args.includes('--ui');
const filter = args.filter((a) => a !== '--ui');

if (UI && !process.env.REV4A_BASE_URL) {
  console.error([
    'check:ui needs a RUNNING Rev4a instance; it starts none.',
    'Set REV4A_BASE_URL (and REV4A_COOKIE, the value of the rev4a_token cookie), then run it again:',
    '',
    '  REV4A_BASE_URL=http://localhost:3750 REV4A_COOKIE=<token> npm run check:ui',
    '',
    'Optional: REV4A_SHOTS (screenshot directory), REV4A_SIMULATE_CARDS, PW_CHANNEL.',
  ].join('\n'));
  process.exit(2);
}

const pattern = UI ? /^ui-check.*\.mjs$/ : /^test-.+\.(mjs|sh)$/;
const files = readdirSync(dir)
  .filter((f) => pattern.test(f))
  .filter((f) => filter.length === 0 || filter.some((s) => f.includes(s)))
  .sort();

if (files.length === 0) {
  console.error('run-tests: no matching files.');
  process.exit(1);
}

function run(file) {
  const full = path.join(dir, file);
  const [cmd, args] = file.endsWith('.sh') ? ['bash', [full]] : [process.execPath, UI ? [full] : [...NODE_FLAGS, full]];
  return new Promise((resolve) => {
    const started = Date.now();
    // Own process group: a timed-out test is killed with everything it started, so a background
    // child holding the pipes can neither keep the run waiting nor survive it.
    const child = spawn(cmd, args, { cwd: path.resolve(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const killAll = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; killAll(); }, TIMEOUT_MS);
    // A test that exits but leaves a child holding the pipes: stop waiting shortly after the exit.
    child.on('exit', () => { setTimeout(() => { killAll(); }, 2000).unref(); });
    child.on('error', (e) => { out += `\n${e.message}\n`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ file, code, signal, timedOut, out, ms: Date.now() - started });
    });
  });
}

const t0 = Date.now();
const results = [];
for (const file of files) {
  if (SKIP[file]) {
    console.log(`SKIP  ${file}  (${SKIP[file]})`);
    results.push({ file, skipped: true });
    continue;
  }
  const r = await run(file);
  const ok = r.code === 0 && !r.timedOut;
  const why = r.timedOut ? ` timed out after ${TIMEOUT_MS} ms` : ok ? '' : ` exit ${r.code ?? r.signal}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  ${(r.ms / 1000).toFixed(1)}s${why}`);
  if (!ok || VERBOSE) console.log(r.out.trimEnd().split('\n').map((l) => `      ${l}`).join('\n'));
  results.push({ ...r, ok });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped, ${results.length} total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log(`Failed: ${failed.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
