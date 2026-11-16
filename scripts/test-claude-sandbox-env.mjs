#!/usr/bin/env node
/**
 * BUG-22: IS_SANDBOX=1 in the agent's Claude Code settings (lib/claude-sandbox-env.js): the pure
 * merge, the output parser, and the container script executed against a temp directory.
 *
 *   node scripts/test-claude-sandbox-env.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Optional module path lets the exact regression run against a saved pre-fix module.
const modulePath = process.argv[2] ? path.resolve(process.argv[2]) : require.resolve('../lib/claude-sandbox-env.js');
const m = require(modulePath);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const pretty = (o) => JSON.stringify(o, null, 2) + '\n';

test('missing file is created', () => {
  assert.deepEqual(m.ensureSandboxEnv(null), { result: 'set', text: pretty({ env: { IS_SANDBOX: '1' } }) });
});
test('empty and whitespace-only files are created', () => {
  assert.equal(m.ensureSandboxEnv('').result, 'set');
  assert.equal(m.ensureSandboxEnv(' \n\t').text, pretty({ env: { IS_SANDBOX: '1' } }));
});
test('other keys are kept', () => {
  assert.deepEqual(m.ensureSandboxEnv('{"theme":"dark"}'), { result: 'set', text: pretty({ theme: 'dark', env: { IS_SANDBOX: '1' } }) });
});
test('other env variables are kept', () => {
  const r = m.ensureSandboxEnv('{"env":{"FOO":"bar"},"theme":"dark"}');
  assert.equal(r.result, 'set');
  assert.deepEqual(JSON.parse(r.text), { env: { FOO: 'bar', IS_SANDBOX: '1' }, theme: 'dark' });
});
test('IS_SANDBOX already 1 is ok and writes nothing', () => {
  assert.deepEqual(m.ensureSandboxEnv('{"env":{"IS_SANDBOX":"1"}}'), { result: 'ok', text: null });
});
test('IS_SANDBOX 0 is replaced by 1', () => {
  const r = m.ensureSandboxEnv('{"env":{"IS_SANDBOX":"0","A":"b"}}');
  assert.equal(r.result, 'set');
  assert.deepEqual(JSON.parse(r.text).env, { IS_SANDBOX: '1', A: 'b' });
});
test('unreadable content is invalid', () => {
  for (const t of ['{not json', '[]', '"x"', '42', 'null', '{"env":[]}', '{"env":"x"}', '{"env":null}']) {
    assert.deepEqual(m.ensureSandboxEnv(t), { result: 'invalid', text: null }, t);
  }
});
test('parseEnsureSandboxResult', () => {
  for (const r of ['ok', 'set', 'invalid', 'error']) assert.equal(m.parseEnsureSandboxResult(`{"result":"${r}"}\n`), r);
  for (const bad of ['', 'nope', '{"result":"x"}', '{}', '{"result":"ok"}\n{"result":"set"}', null, undefined]) {
    assert.equal(m.parseEnsureSandboxResult(bad), null, String(bad));
  }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-env-'));
try {
  const { minify } = require('next/dist/compiled/terser');
  const wrapped = `(function(module, exports, require) {\n${fs.readFileSync(modulePath, 'utf8')}\n})(module, exports, require);`;
  const minified = await minify(wrapped, { mangle: { toplevel: true } });
  const bundled = { exports: {} };
  vm.runInNewContext(minified.code, { module: bundled, exports: bundled.exports, require });
  test('bundled script: top-level mangling still sets IS_SANDBOX', () => {
    const f = path.join(root, 'bundled', 'settings.json');
    const src = bundled.exports.ENSURE_SANDBOX_ENV_SCRIPT.split(m.CLAUDE_SETTINGS_PATH).join(f);
    assert.notEqual(src, bundled.exports.ENSURE_SANDBOX_ENV_SCRIPT, 'the fixed path is in the script');
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', src], { encoding: 'utf8' });
    assert.equal(out, '{"result":"set"}\n');
    assert.equal(fs.readFileSync(f, 'utf8'), pretty({ env: { IS_SANDBOX: '1' } }));
  });
  const run = (file) => {
    const src = m.ENSURE_SANDBOX_ENV_SCRIPT.split(m.CLAUDE_SETTINGS_PATH).join(file);
    assert.notEqual(src, m.ENSURE_SANDBOX_ENV_SCRIPT, 'the fixed path is in the script');
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', src], { encoding: 'utf8' });
    assert.equal(out.trim().split('\n').length, 1, 'one line');
    assert.equal(out.endsWith('\n'), true);
    return { out, result: m.parseEnsureSandboxResult(out) };
  };
  const mode = (f) => fs.statSync(f).mode & 0o777;

  test('script: missing file is created with mode 0600', () => {
    const f = path.join(root, 'new', '.claude', 'settings.json');
    assert.equal(run(f).result, 'set');
    assert.equal(fs.readFileSync(f, 'utf8'), pretty({ env: { IS_SANDBOX: '1' } }));
    assert.equal(mode(f), 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['settings.json'], 'no temp file left');
  });
  test('script: existing file is merged, mode kept, second run is ok and byte-identical', () => {
    const f = path.join(root, 'merge.json');
    fs.writeFileSync(f, '{"theme":"dark"}');
    fs.chmodSync(f, 0o644);
    const first = run(f);
    assert.equal(first.out, '{"result":"set"}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'dark', env: { IS_SANDBOX: '1' } });
    assert.equal(mode(f), 0o644);
    const before = fs.readFileSync(f);
    assert.equal(run(f).result, 'ok');
    assert.deepEqual(fs.readFileSync(f), before);
    assert.equal(mode(f), 0o644);
  });
  test('script: invalid JSON is left byte-identical and its content is never printed', () => {
    const f = path.join(root, 'bad.json');
    fs.writeFileSync(f, '{"secret-marker": nope');
    const before = fs.readFileSync(f);
    const r = run(f);
    assert.equal(r.result, 'invalid');
    assert.equal(r.out.includes('secret-marker'), false);
    assert.deepEqual(fs.readFileSync(f), before);
  });
  test('script: an fs error answers error', () => {
    const f = path.join(root, 'dir.json');
    fs.mkdirSync(f);
    assert.equal(run(f).result, 'error');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${n} tests passed`);
