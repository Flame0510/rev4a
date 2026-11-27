import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

const agent = { agentId: 'atlas', containerName: 'openclaw-atlas' };
const catalogue = [{ id: 'default' }, { id: 'listed', deprecated: true }, { id: 'keyed' }];
const models = { providers: { rev4a: { models: catalogue } } };

async function summary(agents) {
  const { GET } = load('app/api/agents/models-summary/route.ts', {
    'next/server': { NextResponse: Response },
    child_process: {
      execFile(command, args, _options, callback) {
        assert.equal(command, 'docker');
        assert.equal(args[0], 'ps');
        callback(null, { stdout: `${agent.agentId}\t${agent.containerName}\trunning` });
      },
    },
    util: { promisify },
    '@/lib/docker-exec': {
      async dockerExecNoFail(name, args) {
        assert.equal(name, agent.containerName);
        assert.deepEqual(Array.from(args), ['cat', '/root/.openclaw/openclaw.json']);
        return JSON.stringify({ agents, models });
      },
      mapWithConcurrency: (items, _limit, mapper) => Promise.all(items.map(mapper)),
    },
    '@/lib/model-catalogue': { loadModelsConfig: () => catalogue, loadOfferedModels: () => catalogue.slice(0, 2) },
    '@/lib/container-file': {},
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
    '@/lib/agent-model-setup': load('lib/agent-model-setup.ts'),
  });
  const response = await GET(new Request('http://fixture.test/api/agents/models-summary'));
  assert.equal(response.status, 200);
  return response.json();
}

const list = [{ id: 'other', model: 'other' }, { id: 'main', model: 'rev4a/listed' }];
const entries = { main: { model: { primary: 'rev4a/keyed' } } };
const emptyFallbacks = { fallbackCount: 0, firstFallback: null };
const cases = [
  ['defaults beat both main entries and preserve fallback metadata',
    { defaults: { model: { primary: 'rev4a/default', fallbacks: ['rev4a/backup', null] } }, list, entries },
    { primary: 'rev4a/default', health: 'ok', fallbackCount: 2, firstFallback: 'rev4a/backup' }],
  ['list main supplies primary and health when defaults has only fallbacks',
    { defaults: { model: { fallbacks: ['rev4a/backup'] } }, list },
    { primary: 'rev4a/listed', health: 'deprecated', fallbackCount: 1, firstFallback: 'rev4a/backup' }],
  ['keyed main supplies primary and health when only that entry has a model',
    { entries }, { primary: 'rev4a/keyed', health: 'disabled', ...emptyFallbacks }],
  ['list main takes precedence over keyed main',
    { list, entries }, { primary: 'rev4a/listed', health: 'deprecated', ...emptyFallbacks }],
  ['keyed main supplies primary when list main has an empty primary',
    { list: [list[0], { id: 'main', model: { primary: '' } }], entries },
    { primary: 'rev4a/keyed', health: 'disabled', ...emptyFallbacks }],
  ['no effective primary yields an unset row',
    { list: [list[0]], entries: { main: { model: '' } } },
    { primary: null, health: 'unset', ...emptyFallbacks }],
];

for (const [name, agents, expected] of cases) {
  test(name, async () => {
    assert.deepEqual(await summary(agents), { agents: [{ ...agent, ...expected }] });
  });
}
