#!/usr/bin/env node
/** Verify the fields actually written to openclaw.json. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../lib/gateway-agent-verify.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { modelWriteVerified } = exports;
const expected = { primary: 'rev4a/new', fallbacks: ['rev4a/first', 'openai/second'], mainPrimary: 'rev4a/new' };
const model = { primary: expected.primary, fallbacks: expected.fallbacks };
const defaults = { model };
const main = { id: 'main', model };
const list = [main];
const verify = (config) => modelWriteVerified(JSON.stringify(config), expected);

assert.equal(verify({ agents: { defaults, list } }), true, 'matching primary, fallbacks and main');
assert.equal(modelWriteVerified(JSON.stringify({ agents: { defaults } }), model), true, 'no main entry was written');
assert.equal(verify({ other: { primary: expected.primary } }), false, 'primary in the wrong field');
assert.equal(verify({ agents: { defaults: { model: { ...model, primary: 'rev4a/old' } }, list } }), false, 'different primary');
for (const fallbacks of [undefined, 'rev4a/first', ['rev4a/first'], ['rev4a/first', 'rev4a/other'], [...model.fallbacks].reverse()]) {
  assert.equal(verify({ agents: { defaults: { model: { ...model, fallbacks } }, list } }), false, 'different fallbacks');
}
assert.equal(verify({ agents: { defaults, list: [{ id: 'main', model: { primary: 'rev4a/old' } }] } }), false, 'different main primary');
for (const list of [undefined, {}, [null, { id: 'worker', model }]]) {
  assert.equal(verify({ agents: { defaults, list } }), false, 'missing main entry');
}
for (const raw of ['', '{"primary":', 'null']) {
  assert.equal(modelWriteVerified(raw, expected), false, 'empty, invalid or null read-back');
}
assert.equal(modelWriteVerified(JSON.stringify({ agents: { defaults: { model: { primary: 'rev4a/new' } } } }), { primary: 'rev4a/new', fallbacks: [] }), true, 'a dropped empty fallbacks list reads as []');
console.log('ok   model read-back requires matching values at the written paths');
