#!/usr/bin/env node
/**
 * Tests for lib/credentials/file-mode.ts — the 0600 tightening of credentials.db and its
 * -wal / -shm companions. Run it with
 *
 *   node scripts/test-credentials-mode.mjs
 *
 * Plain node strips the TypeScript types (Node >= 22.18), so this runs the real module. It
 * exits non-zero on the first failing case. (Not wired into CI: the repo has no test runner
 * yet, so this is a script, like check-language.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureDbFiles } from '../lib/credentials/file-mode.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-credentials-mode-'));
// Runs on a normal exit and on process.exit(1); a finally block would not see the latter.
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

let passed = 0;
let dirSeq = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e?.stack || e}`);
    process.exit(1);
  }
}

const newDir = () => fs.mkdirSync(path.join(root, `case-${dirSeq++}`), { recursive: true });
const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('a missing file is created 0600 even with umask 0o022', () => {
  const dbPath = path.join(newDir(), 'credentials.db');
  const previous = process.umask(0o022);
  try {
    secureDbFiles(dbPath);
  } finally {
    process.umask(previous);
  }
  assert.ok(fs.existsSync(dbPath), 'the file was not created');
  assert.equal(modeOf(dbPath), 0o600);
});

test('missing -wal / -shm are not created', () => {
  const dbPath = path.join(newDir(), 'credentials.db');
  secureDbFiles(dbPath);
  assert.ok(!fs.existsSync(`${dbPath}-wal`), '-wal was created');
  assert.ok(!fs.existsSync(`${dbPath}-shm`), '-shm was created');
});

test('an existing 0644 file and its 0644 -wal / -shm become 0600, content unchanged', () => {
  const dbPath = path.join(newDir(), 'credentials.db');
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const file of files) {
    fs.writeFileSync(file, `payload:${path.basename(file)}`);
    fs.chmodSync(file, 0o644);
  }
  secureDbFiles(dbPath);
  for (const file of files) {
    assert.equal(modeOf(file), 0o600, `${file} is not 0600`);
    assert.equal(fs.readFileSync(file, 'utf8'), `payload:${path.basename(file)}`, `${file} content changed`);
  }
});

test('a second call is harmless', () => {
  const dbPath = path.join(newDir(), 'credentials.db');
  secureDbFiles(dbPath);
  secureDbFiles(dbPath);
  assert.equal(modeOf(dbPath), 0o600);
  assert.ok(!fs.existsSync(`${dbPath}-wal`));
  assert.ok(!fs.existsSync(`${dbPath}-shm`));
});

test('a failing chmod does not throw and warns once, naming the file', () => {
  const dbPath = path.join(newDir(), 'credentials.db');
  fs.writeFileSync(dbPath, 'secret');
  fs.chmodSync(dbPath, 0o644);

  const warnings = [];
  const originalWarn = console.warn;
  const originalChmod = fs.chmodSync;
  console.warn = (...args) => warnings.push(args.join(' '));
  fs.chmodSync = () => {
    const err = new Error('EACCES: simulated chmod failure');
    err.code = 'EACCES';
    throw err;
  };
  try {
    assert.doesNotThrow(() => secureDbFiles(dbPath));
    assert.doesNotThrow(() => secureDbFiles(dbPath));
  } finally {
    fs.chmodSync = originalChmod;
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
  assert.ok(warnings[0].includes(dbPath), `the warning does not name the file: ${warnings[0]}`);
});

console.log(`\n${passed} cases passed`);
