// FIX-133: every value Rev4a writes to .env is read back identically by Next's own dotenv
// (@next/env) and by Rev4a's line reader (unquoteEnvValue). Values that cannot be written
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
    const line = content.split('\n').find((l) => l.startsWith('REV4A_TEST='));
    assert.ok(!value.includes('$'), 'values with $ must be refused (Next expands them and overrides the launcher)');
    assert.equal(parsedEnv.REV4A_TEST, value, `Next reads ${JSON.stringify(value)} back`);
    assert.equal(envFile.unquoteEnvValue(line.slice('REV4A_TEST='.length)), value, `Rev4a reads ${JSON.stringify(value)} back`);
    assert.equal(parsedEnv.GATEWAY_TOKEN, 'g');
    passed++;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`ok   ${passed} values read back exactly by @next/env and Rev4a; ${refused} refused as not representable (incl. every value with $)`);
assert.ok(passed >= 13); assert.ok(refused >= 4);
console.log('\nenv round-trip checks passed');
