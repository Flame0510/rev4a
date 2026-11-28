#!/usr/bin/env node
/** Config setup logs may report the error kind and exit code. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { format } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies, capturedConsole) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    exports: module.exports,
    console: capturedConsole,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return module.exports;
}

const fixtureCredential = 'sk-live-FAKECRED-123'; // secret-ok: synthetic fixture
const rawConfig = `{"apiKey": "${fixtureCredential}", "fixtureTail": [!`;
const redactor = load('lib/redact-secret.ts', { './update-state.js': {} });
const { configErrorSummary } = redactor;

const patchError = Object.assign(new Error(rawConfig), {
  status: 2,
  stderr: rawConfig,
  stdout: fixtureCredential,
});

assert.equal(configErrorSummary(new SyntaxError(rawConfig)), 'SyntaxError');
assert.equal(configErrorSummary(patchError), 'Error (exit 2)');
assert.equal(configErrorSummary(fixtureCredential), 'Error');
assert.equal(configErrorSummary({ name: 'Invalid config name' }), 'Error');
// lib/docker-exec.ts failures carry no exit field: only the fixed prefix of the message is used.
assert.equal(configErrorSummary(new Error(`docker exec agent_x: exit 2 — ${rawConfig}`)), 'Error (exit 2)');
assert.equal(configErrorSummary(new Error(`docker exec agent_x: timed out or was killed (exit 137) — ${rawConfig}`)), 'Error (timed out)');
assert.equal(configErrorSummary(new Error('docker exec timed out after 15000ms')), 'Error (timed out)');
assert.equal(configErrorSummary(new Error('docker exec exited with code 3')), 'Error (exit 3)');
assert.equal(configErrorSummary(new Error(`${fixtureCredential} docker exec agent_x: exit 2`)), 'Error');
let reads = 0;
assert.equal(configErrorSummary({ get name() { return reads++ < 1 ? 'Error' : fixtureCredential; } }), 'Error', 'name is read once');
assert.equal(configErrorSummary({ get name() { throw new Error(fixtureCredential); } }), 'Error', 'a throwing getter');
assert.equal(configErrorSummary({ name: 'Patch_Error', status: 0, code: 3 }), 'Patch_Error (exit 0)');
assert.equal(configErrorSummary({ name: 'Error', status: 1.5, code: 4 }), 'Error (exit 4)');
assert.equal(configErrorSummary({ name: 'Error', status: Infinity, code: '4' }), 'Error');
console.log('ok   config error summaries use a safe name and an optional integer exit code');

const messages = [];
const capturedConsole = Object.fromEntries(Object.keys(console)
  .filter((method) => typeof console[method] === 'function')
  .map((method) => [method, (...args) => messages.push([method, format(...args)])]));
const { applyRuntimeConfig } = load('lib/agent-setup.ts', {
  fs: {},
  '@/lib/rev4a-paths': {},
  '@/lib/docker-exec': {
    async dockerExec(container, args) {
      assert.equal(container, 'agent_fixture');
      assert.deepEqual(Array.from(args), ['cat', '/root/.openclaw/openclaw.json']);
      return rawConfig;
    },
    async dockerExecWithInput() { throw patchError; },
  },
  '@/lib/gateway-cli': { gatewayCliArgv: (args) => args },
  '@/lib/credentials/delivery': {
    async reapplyWhenReady() { throw new TypeError(rawConfig); },
  },
  '@/lib/agent-config-lock': { withAgentConfigLock: (_container, run) => run() },
  '@/lib/redact-secret': redactor,
}, capturedConsole);

await applyRuntimeConfig('agent_fixture');
// Credential delivery runs in the background. Let its rejection handler run before checking.
await new Promise(setImmediate);
assert.ok(messages.every(([, line]) => !line.includes(fixtureCredential)));
assert.deepEqual(messages, [
  ['warn', '[agent-setup] config patch failed on agent_fixture: Error (exit 2)'],
  ['warn', '[agent-setup] config patch failed on agent_fixture: Error (exit 2)'],
  ['warn', '[agent-setup] Control UI origin policy not applied on agent_fixture: SyntaxError'],
  ['warn', '[agent-setup] credentials not re-applied on agent_fixture: TypeError'],
]);
console.log('ok   runtime config patch, JSON parse and credential re-apply logs contain no config text');
