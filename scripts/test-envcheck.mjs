#!/usr/bin/env node
/**
 * Tests for lib/envcheck.ts — the fixed key list and the set / not set description behind
 * GET /api/envcheck. The point is a secret leaking no part of its value, so the cases below
 * check that nothing of a secret's value appears in the answer. No server, no network: the
 * pure function is compiled from TypeScript and called directly. Run it with
 *
 *   node scripts/test-envcheck.mjs
 *
 * and it exits non-zero on the first failing case.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Load the TypeScript module with the compiler already in dependencies, so the script runs
// on any Node version the package supports without a type-stripping flag.
function loadEnvcheck() {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'envcheck.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', compiled)(module.exports, module);
  return module.exports;
}

const { ENVCHECK_KEYS, SENSITIVE_KEYS, describeEnv } = loadEnvcheck();

let passed = 0;
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

const SECRETS = ['REV4A_PASSWORD', 'REV4A_TOKEN', 'REV4A_JWT_SECRET', 'PROVIDER_DEEPSEEK_API_KEY'];

test('the fixed key list and the sensitive list are exactly the ones the endpoint had', () => {
  assert.deepEqual(ENVCHECK_KEYS, [
    'REV4A_PASSWORD',
    'REV4A_TOKEN',
    'REV4A_JWT_SECRET',
    'REV4A_ALERTS_ENABLED',
    'REV4A_DB',
    'REV4A_WORKSPACE_ROOT',
    'PROVIDER_DEEPSEEK_API_KEY',
    'NODE_ENV',
  ]);
  assert.deepEqual(SENSITIVE_KEYS, SECRETS);
  for (const key of SENSITIVE_KEYS) {
    assert.ok(ENVCHECK_KEYS.includes(key), `${key} is sensitive but not reported`);
  }
});

test('only the fixed keys are in the result, whatever the environment holds', () => {
  const result = describeEnv({
    HOME: '/root',
    PATH: '/usr/bin',
    AWS_SECRET_ACCESS_KEY: 'should-never-appear',
    MY_CUSTOM_KEY: 'should-never-appear-either',
  });
  assert.deepEqual(Object.keys(result), ENVCHECK_KEYS);
  const json = JSON.stringify(result);
  assert.ok(!json.includes('should-never-appear'));
  assert.ok(!json.includes('/root'));
});

test('a non-sensitive key passes its value through, missing or empty is "(not set)"', () => {
  const result = describeEnv({ REV4A_ALERTS_ENABLED: '1', NODE_ENV: 'test', REV4A_DB: '/data/events.db' });
  assert.equal(result.REV4A_ALERTS_ENABLED, '1');
  assert.equal(result.NODE_ENV, 'test');
  assert.equal(result.REV4A_DB, '/data/events.db');
  assert.equal(result.REV4A_WORKSPACE_ROOT, '(not set)', 'missing key');
  assert.equal(describeEnv({ REV4A_DB: '' }).REV4A_DB, '(not set)', 'empty key');
});

test('a secret answers exactly "set" / "not set", never a value', () => {
  const set = describeEnv(Object.fromEntries(SECRETS.map((k) => [k, 'abcd1234'])));
  for (const key of SECRETS) assert.equal(set[key], 'set');
  const unset = describeEnv({});
  for (const key of SECRETS) assert.equal(unset[key], 'not set');
  const empty = describeEnv(Object.fromEntries(SECRETS.map((k) => [k, ''])));
  for (const key of SECRETS) assert.equal(empty[key], 'not set');
});

// The leak this endpoint used to have was the first four characters of a secret.
for (const value of ['abcd1234', 'x']) {
  test(`no part of the secret "${value}" appears in the answer`, () => {
    const result = describeEnv(Object.fromEntries(SECRETS.map((k) => [k, value])));
    const json = JSON.stringify(result);
    // The returned values are the only content a caller reads: scan them character by
    // character. (The JSON keys contain letters and the digit 4, so scanning the whole
    // JSON would flag the key names, not a leak.)
    const values = Object.values(result).join('\n');
    for (const ch of value) {
      assert.ok(!values.includes(ch), `character "${ch}" of the secret leaked into a value`);
    }
    // And no prefix of the secret may appear anywhere in the JSON: the old leak was
    // "✅ set (abcd...)", which carried "abcd".
    for (let i = 1; i <= value.length; i++) {
      const prefix = value.slice(0, i);
      assert.ok(!json.includes(prefix), `prefix "${prefix}" of the secret leaked into the JSON`);
    }
  });
}

test('a one-character secret is still only "set", and an empty / missing one is "not set"', () => {
  assert.equal(describeEnv({ REV4A_PASSWORD: 'x' }).REV4A_PASSWORD, 'set');
  assert.equal(describeEnv({ REV4A_PASSWORD: '' }).REV4A_PASSWORD, 'not set');
  assert.equal(describeEnv({}).REV4A_PASSWORD, 'not set');
});

test('a secret next to an extra env key leaks neither', () => {
  const result = describeEnv({
    REV4A_PASSWORD: 'abcd1234',
    PROVIDER_DEEPSEEK_API_KEY: 'sk-live-0000000000000000',
    UNRELATED: 'aaaa',
  });
  const json = JSON.stringify(result);
  for (const probe of ['abcd', 'abcd1234', 'sk-live', 'sk-l', '0000', 'aaaa']) {
    assert.ok(!json.includes(probe), `"${probe}" leaked`);
  }
  assert.equal(result.REV4A_PASSWORD, 'set');
  assert.equal(result.PROVIDER_DEEPSEEK_API_KEY, 'set');
});

console.log(`\n${passed} cases passed`);
