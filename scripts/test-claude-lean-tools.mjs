/**
 * FEAT-27.1: tests of lib/claude-lean-tools.ts (the list, the pure decision, the write path with Docker stubbed).
 * Run: node scripts/test-claude-lean-tools.mjs
 */
import assert from 'node:assert/strict';
import fsx from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const label = require('../lib/claude-cli-label.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const testAsync = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

const ROUTE = { agents: { defaults: { models: { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } } } } } };

function load({ reads, execs, patchFails = false, lockCalls = [], listing = [] }) {
  const source = fsx.readFileSync(new URL('../lib/claude-lean-tools.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const logs = { log: [], warn: [] };
  const sandbox = {
    module, exports: module.exports, JSON, Promise, Array, Object,
    console: { log: (m) => logs.log.push(m), warn: (m) => logs.warn.push(m) },
  };
  sandbox.globalThis = sandbox;
  let read = 0;
  const dependencies = {
    '@/lib/docker-exec': {
      dockerExec: async () => {
        const r = reads[Math.min(read++, reads.length - 1)];
        if (r instanceof Error) throw r;
        return typeof r === 'string' ? r : JSON.stringify(r);
      },
      dockerExecWithInput: async (_c, argv, input) => {
        execs.push([...argv, input]);
        if (patchFails) throw new Error('timeout');
        return '';
      },
    },
    '@/lib/agent-config-lock': { withAgentConfigLock: async (c, fn) => { lockCalls.push(c); return fn(); } },
    '@/lib/credentials/native': { OPENCLAW_RELOAD_TIMEOUT_MS: 150000 },
    '@/lib/claude-cli-label': label,
    '@/lib/agent-containers': { listAgentContainers: async () => listing },
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', sandbox)(
    (name) => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return { mod: module.exports, logs };
}

const { mod } = load({ reads: [''], execs: [] });
const decide = (cfg) => mod.decideLeanTools(typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
const withTools = (tools) => ({ ...ROUTE, tools });

test('the list is exactly the 24 names, in order, no duplicates, none of the tools that stay on', () => {
  const expected = ('computer, mobile_ui, nodes, node_inference, presence, screen, talk_voice, canvas, theme, dashboard, portal, terminal, '
    + 'show_widget, file_fetch, file_write, dir_fetch, dir_list, create_goal, get_goal, update_goal, intent, transcripts, '
    + 'codex_plugins, openclaw').split(', ');
  assert.equal(expected.length, 24);
  assert.deepEqual([...mod.CLAUDE_LEAN_TOOLS_DENY], expected);
  assert.equal(new Set(mod.CLAUDE_LEAN_TOOLS_DENY).size, 24);
  for (const keep of ['exec', 'process', 'read', 'write', 'edit', 'message', 'automations', 'browser', 'pdf', 'tts',
    'web_fetch', 'web_search', 'sessions_spawn', 'memory_search', 'gateway', 'secrets']) {
    assert.equal(mod.CLAUDE_LEAN_TOOLS_DENY.includes(keep), false, keep);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(mod.LEAN_TOOLS_PATCH)), { tools: { byProvider: { anthropic: { deny: expected } } } });
});

test('decide: invalid text, an array and a scalar are invalid', () => {
  assert.equal(decide('not json'), 'invalid');
  assert.equal(decide(''), 'invalid');
  assert.equal(decide('[]'), 'invalid');
  assert.equal(decide('null'), 'invalid');
  assert.equal(decide('3'), 'invalid');
});

test('decide: Claude route off is not-claude', () => {
  assert.equal(decide({}), 'not-claude');
  assert.equal(decide({ agents: { defaults: { models: {} } } }), 'not-claude');
});

test('decide: Claude on and the key absent is write', () => {
  assert.equal(decide(ROUTE), 'write');
  assert.equal(decide(withTools({})), 'write');
  assert.equal(decide(withTools({ byProvider: {} })), 'write');
  assert.equal(decide(withTools({ byProvider: { anthropic: {} } })), 'write');
  assert.equal(decide(withTools({ byProvider: { anthropic: { allow: ['exec'] } } })), 'write');
  assert.equal(decide(withTools({ deny: ['x'], byProvider: { openai: { deny: ['y'] } } })), 'write');
});

test('decide: any value of deny is present', () => {
  for (const deny of [['canvas'], [], null, 'canvas', 0, {}]) {
    assert.equal(decide(withTools({ byProvider: { anthropic: { deny } } })), 'present', JSON.stringify(deny));
  }
});

test('decide: a shape that is not understood is present, never patched', () => {
  assert.equal(decide(withTools(null)), 'present');
  assert.equal(decide(withTools([])), 'present');
  assert.equal(decide(withTools('x')), 'present');
  assert.equal(decide(withTools({ byProvider: null })), 'present');
  assert.equal(decide(withTools({ byProvider: [] })), 'present');
  assert.equal(decide(withTools({ byProvider: { anthropic: null } })), 'present');
  assert.equal(decide(withTools({ byProvider: { anthropic: [] } })), 'present');
  assert.equal(decide(withTools({ byProvider: { anthropic: 'x' } })), 'present');
});

await testAsync('ensure: writes under one lock hold and reports written when the read-back shows the list', async () => {
  const execs = []; const lockCalls = [];
  const after = withTools({ byProvider: { anthropic: { deny: [...mod.CLAUDE_LEAN_TOOLS_DENY] } } });
  const { mod: m, logs } = load({ reads: [ROUTE, after], execs, lockCalls });
  assert.equal(await m.ensureLeanClaudeTools('c1'), 'written');
  assert.equal(lockCalls.length, 1);
  assert.equal(execs.length, 1);
  assert.deepEqual(execs[0].slice(0, 4), ['openclaw', 'config', 'patch', '--stdin']);
  assert.deepEqual(JSON.parse(execs[0][4]), JSON.parse(JSON.stringify(m.LEAN_TOOLS_PATCH)));
  assert.equal(logs.log.length, 1);
  assert.match(logs.log[0], /switched off 24 unused tools on Claude runs in c1/);
});

await testAsync('ensure: an existing list (even empty) makes no patch and no log', async () => {
  for (const deny of [[], ['canvas']]) {
    const execs = [];
    const { mod: m, logs } = load({ reads: [withTools({ byProvider: { anthropic: { deny } } })], execs });
    assert.equal(await m.ensureLeanClaudeTools('c1'), 'present');
    assert.equal(execs.length, 0);
    assert.deepEqual([logs.log, logs.warn], [[], []]);
  }
});

await testAsync('ensure: not-claude is silent, invalid warns without the content', async () => {
  const execs = [];
  const a = load({ reads: [{}], execs });
  assert.equal(await a.mod.ensureLeanClaudeTools('c1'), 'not-claude');
  assert.deepEqual([a.logs.log, a.logs.warn, execs], [[], [], []]);
  const b = load({ reads: ['SECRET-not-json'], execs });
  assert.equal(await b.mod.ensureLeanClaudeTools('c1'), 'invalid');
  assert.equal(b.logs.warn.length, 1);
  assert.equal(b.logs.warn[0].includes('SECRET'), false);
});

await testAsync('ensure: a patch exec that fails but a read-back that shows the list is written', async () => {
  const execs = [];
  const after = withTools({ byProvider: { anthropic: { deny: [...mod.CLAUDE_LEAN_TOOLS_DENY] } } });
  const { mod: m } = load({ reads: [ROUTE, after], execs, patchFails: true });
  assert.equal(await m.ensureLeanClaudeTools('c1'), 'written');
});

await testAsync('ensure: a read-back without the list, or an unreadable one, is failed and never throws', async () => {
  const a = load({ reads: [ROUTE, ROUTE], execs: [] });
  assert.equal(await a.mod.ensureLeanClaudeTools('c1'), 'failed');
  assert.equal(a.logs.warn.length, 1);
  const b = load({ reads: [ROUTE, new Error('exec failed')], execs: [], patchFails: true });
  assert.equal(await b.mod.ensureLeanClaudeTools('c1'), 'failed');
  const c = load({ reads: [new Error('exec failed')], execs: [] });
  assert.equal(await c.mod.ensureLeanClaudeTools('c1'), 'failed');
});

await testAsync('startup repair: running agents only, one failing agent does not stop the others', async () => {
  const execs = []; const lockCalls = [];
  const after = withTools({ byProvider: { anthropic: { deny: [...mod.CLAUDE_LEAN_TOOLS_DENY] } } });
  const { mod: m, logs } = load({
    reads: [new Error('gone'), ROUTE, after],
    execs, lockCalls,
    listing: [
      { container: 'bad', running: true }, { container: 'stopped', running: false }, { container: 'good', running: true },
    ],
  });
  assert.equal(await m.repairLeanClaudeToolsAtStartup(), 1);
  assert.deepEqual(lockCalls, ['bad', 'good']);
  assert.equal(logs.log.filter((l) => /on startup/.test(l)).length, 1);
});

console.log(`\n${n} passed`);
