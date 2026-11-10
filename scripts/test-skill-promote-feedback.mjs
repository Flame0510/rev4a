#!/usr/bin/env node
/** FIX-133: run the actual client promote handler with offline fetch/toast mocks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../app/skills/PageClient.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PageClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handlePromote') handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler, 'actual promote handler');
const compiled = ts.transpileModule(`const handlePromote = ${handler.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function promote(response) {
  const messages = [];
  const states = [];
  let reloads = 0;
  const context = vm.createContext({
    showToast: (message) => messages.push(message), setPromoting: (state) => states.push(state),
    load: async () => { reloads++; },
    fetch: async (url, options) => {
      assert.equal(url, '/api/skills/promote');
      assert.deepEqual(JSON.parse(options.body), { containerName: 'agent-demo', skillName: 'demo' });
      return { json: async () => response };
    },
  });
  vm.runInContext(`${compiled}\nglobalThis.run = handlePromote;`, context);
  await context.run({ name: 'demo', containerName: 'agent-demo' });
  assert.deepEqual(states, ['demo', null]);
  return { messages, reloads };
}

for (const response of [
  { ok: true },
  { ok: true, skippedCount: 0, skipped: [] },
  { ok: true, skippedCount: 1, skipped: ['last-asset.png'] },
  { ok: true, overwritten: true, skippedCount: 3, skipped: ['a', 'b'] },
  { ok: true, skippedCount: 2 },
  { ok: false, error: 'Nothing was promoted' },
]) {
  const { messages, reloads } = await promote(response);
  assert.equal(messages.length, 1);
  assert.equal(reloads, response.ok ? 1 : 0);
  if (!response.ok) assert.equal(messages[0], 'Error: Nothing was promoted');
  else if (!response.skippedCount) assert.equal(messages[0], 'Promoted "demo" to shared skills');
  else {
    assert.match(messages[0], new RegExp(`${response.skippedCount} files? skipped`));
    for (const name of response.skipped ?? []) assert.ok(messages[0].includes(name));
    if (response.overwritten) assert.equal(messages[0], 'Promoted "demo" to shared skills (overwritten) — 3 files skipped: a, b, …');
  }
}
console.log('ok   complete, partial, sampled, legacy and failed promotion feedback');
