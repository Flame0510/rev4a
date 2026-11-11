// FIX-133: every value Rev4a writes to .env is read back identically by Next's own dotenv
// (@next/env) and by Rev4a's shared reader. Values that cannot be written
// faithfully are refused. Self-contained: temp dirs only, no server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const envFile = require('../lib/env-file.js');
const { loadEnvConfig } = require('@next/env');

const values = ['abc', 'a b c', 'x#y', ' lead', 'trail ', '"dq"', 'it\'s', 'back\\slash', 'end\\',
  'p@$$w0rd!', 'a=b=c', 'tab\there', ' line', 'é ü 😀', '`tick`', '$HOME', '${X}', 'a "b" c'];
let passed = 0; let refused = 0;
for (const value of values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-env-rt-'));
  try {
    let content;
    try {
      ({ content } = envFile.applyEnvEdits('# head\nGATEWAY_TOKEN=g\n', [['REV4A_TEST', value]]));
    } catch (e) {
      assert.equal(e.code, 'UNSAFE_ENV_VALUE', `${JSON.stringify(value)} threw ${e.message}`);
      refused++; continue;
    }
    fs.writeFileSync(path.join(dir, '.env'), content);
    const saved = { ...process.env };
    const { parsedEnv } = loadEnvConfig(dir, false, { info() {}, error() {} }, true);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    assert.ok(!value.includes('$'), 'values with $ must be refused (Next expands them and overrides the launcher)');
    assert.equal(parsedEnv.REV4A_TEST, value, `Next reads ${JSON.stringify(value)} back`);
    assert.equal(envFile.readEnvValue(content, 'REV4A_TEST'), value, `Rev4a reads ${JSON.stringify(value)} back`);
    assert.equal(parsedEnv.GATEWAY_TOKEN, 'g');
    passed++;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`ok   ${passed} values read back exactly by @next/env and Rev4a; ${refused} refused as not representable (incl. every value with $)`);
assert.ok(passed >= 13); assert.ok(refused >= 4);

// Load @next/env in an isolated VM: no host environment can affect these reference values.
const { default: vm } = await import('node:vm');
const nextSource = fs.readFileSync(require.resolve('@next/env'), 'utf8');
const cases = [
  'PLAIN=abc # note\nHASH=abc#note\n',
  'SINGLE=\'abc # literal\' # note\nDOUBLE="abc # literal" # note\nBACKTICK=`abc # literal` # note\n',
  'EMPTY=\nSINGLE=\'\'\nDOUBLE=""\nBACKTICK=``\nCOMMENT= # empty\n',
  'DUP=first\nDUP=last # note\nLAST_EMPTY=first\nLAST_EMPTY=\n',
  'export SPACED = abc # note\nCOLON: value # note\nVENDOR.OPTION=kept\n',
  'ESCAPES="first\\nnext\\rend"\nSINGLE=\'first\\nnext\'\n',
  'MULTILINE="first\nlast" # note\nAFTER=ok\n',
  'UNTERMINATED="value # note\nAFTER=ok\n',
  'QUOTES="first\\"last" # note\n',
];
let comparisons = 0;
for (const newline of ['\n', '\r\n', '\r']) {
  for (const fixture of cases) {
    const content = fixture.replaceAll('\n', newline);
    const nextModule = { exports: {} };
    vm.runInNewContext(nextSource, {
      module: nextModule, exports: nextModule.exports, require, __dirname: '/mock', process: { env: {} }, console,
    });
    const [, reference] = nextModule.exports.processEnv([{ path: '.env', contents: content, env: {} }], '/mock', undefined, true);
    const expected = JSON.parse(JSON.stringify(reference));
    assert.deepEqual({ ...envFile.parseEnvValues(content) }, expected, JSON.stringify(content));
    for (const [key, value] of Object.entries(expected)) assert.equal(envFile.readEnvValue(content, key), value);
    assert.equal(envFile.readEnvValue(content, 'MISSING'), undefined);
    comparisons++;
  }
}
console.log(`ok   ${comparisons} hand-written .env fixtures agree with @next/env (comments, quotes, empties, duplicates, export, colon and line endings)`);
console.log('\nenv round-trip checks passed');
