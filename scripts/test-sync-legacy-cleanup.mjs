import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function load(file, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
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

const versions = load('lib/agent-versions.ts', {
  './agent-versions.json': require('../lib/agent-versions.json'),
  './image-revision': require('../lib/image-revision.js'),
});
const configPath = '/root/.openclaw/openclaw.json';
const marker = '/root/.openclaw/.last-version';
const config = { agents: { defaults: { model: 'rev4a/example' } } };
const cases = [
  ['supported image tag', `openclaw-agent-base:${versions.newestSupportedVersion()}`, '', true],
  ['supported version marker', 'locally-built:latest', versions.newestSupportedVersion(), true],
  ['older unsupported version', 'openclaw-agent-base:2026.8.1', '2026.8.1', false],
  ['unknown version', 'locally-built:latest', '', false],
];

for (const [name, image, lastVersion, shouldClean] of cases) {
  test(`sync ${shouldClean ? 'removes' : 'preserves'} legacy files for ${name}`, async () => {
    const container = 'openclaw-atlas';
    const removals = [];
    const writes = [];
    const { syncAllAgents } = load('app/api/gateway/sync.ts', {
      child_process: {
        execSync(command) {
          if (command.startsWith('docker ps -a')) return `${container}\trunning\tatlas`;
          assert.match(command, /^docker ps --filter.*rev4a\.backup\.agent/);
          return '';
        },
        execFileSync(command, args, options) {
          assert.equal(command, 'docker');
          if (args[0] === 'inspect') return image;
          if (args[0] === 'cp') throw new Error('No saved version marker');
          assert.equal(args[0], 'exec');
          if (args[3] === configPath) return JSON.stringify(config);
          if (args[3] === marker) return lastVersion;
          if (args[2] === 'rm') { removals.push(Array.from(args)); return ''; }
          if (args[1] === '-i') { writes.push(JSON.parse(options.input)); return ''; }
          assert.fail(`Unexpected Docker arguments: ${args}`);
        },
      },
      fs: {}, os: {}, path: {},
      './provider/keys': { readProviderKeys: () => ({ rev4a: 'fixture-key' }) },
      '@/lib/agent-config-lock': { withAgentConfigLock: async (_name, fn) => fn() },
      '@/lib/docker-exec': {},
      '@/lib/gateway-cli': {},
      '@/lib/model-catalogue': { bundledCatalogueStatus: () => 'available', loadOfferedModels: () => [] },
      '@/lib/container-file': {},
      '@/lib/docker-utils': { detectProviderGatewayUrl: () => 'http://fixture.test/api/provider/v1' },
      '@/lib/agent-versions': versions,
      '@/lib/agent-update-state': { activeUpdateAgentIds: () => [] },
      '@/lib/agent-recreate-state': { activeRecreateAgentIds: () => [] },
      '@/lib/agent-restore-state': { activeRestoreAgentIds: () => [] },
      '@/lib/agent-edit-state': { activeEditAgentIds: () => [] },
      '@/lib/agent-names': {},
      '@/lib/model-pricing': {},
      '@/lib/proxy-usage': { AGENT_HEADER: 'X-Rev4a-Agent' },
      '@/lib/agent-proxy-token': { deriveAgentProxyToken: () => 'fixture-agent-token' },
    });

    const outcome = await syncAllAgents();
    assert.equal(outcome.ok, true, outcome.summary);
    assert.deepEqual(Array.from(outcome.synced), [container]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].agents, config.agents);
    assert.ok(writes[0].models.providers.rev4a);
    assert.deepEqual(removals, shouldClean ? [['exec', container, 'rm', '-f',
      '/root/.openclaw/agents/main/agent/models.json',
      '/root/.openclaw/agents/main/agent/auth-profiles.json',
    ]] : []);
  });
}
