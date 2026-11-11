#!/usr/bin/env node
/** Offline SEC-20 regression tests: real token/auth/routes/sync, mocked I/O only. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const tokens = require('../lib/agent-proxy-token.js');
const usage = require('../lib/proxy-usage.js');
const { deriveAgentProxyToken: derive, verifyAgentProxyToken: verify } = tokens;
const key = 'fixture-gateway';
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`ok   ${name}`);
  passed++;
}
function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, Response, Headers, console,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    }, ...globals,
  }, { filename: file });
  return module.exports;
}
const request = (token, agent = null, body = { model: 'deepseek/example', messages: [] }) => {
  const headers = new Headers();
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  if (agent !== null) headers.set(usage.AGENT_HEADER, agent);
  return { headers, json: async () => body };
};

await test('tokens: round trip, exact domain-separated full HMAC, dots and id boundaries', () => {
  for (const id of ['atlas', 'agent_123', 'a.b-c_d', 'a', 'x'.repeat(63), 'x'.repeat(64), 'assistant']) {
    const token = derive(key, id);
    const mac = createHmac('sha256', key).update('rev4a:agent-proxy:v1\0' + id).digest('base64url');
    assert.equal(token, `r4a1.${id}.${mac}`);
    assert.equal(Buffer.from(mac, 'base64url').length, 32);
    assert.equal(verify(key, token), id);
  }
  assert.notEqual(derive(key, 'atlas'), derive(key, 'beta'));
});
await test('tokens: wrong MAC, substituted id, malformed input and rotation refuse', () => {
  const token = derive(key, 'atlas');
  const mac = token.split('.').at(-1);
  for (const bad of [null, undefined, 42, {}, '', key, 'r4a1', token + '.', token + '=',
    token.replace('r4a1.', 'r4a2.'), token.replace('.atlas.', '.beta.'),
    `r4a1.atlas.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`, token.slice(0, -1),
    `r4a1.bad id.${mac}`, `r4a1.${'x'.repeat(65)}.${mac}`, `r4a1.${'x'.repeat(1_000_000)}.${mac}`, `r4a1..${mac}`]) {
    assert.equal(verify(key, bad), null, String(bad));
  }
  assert.equal(verify('rotated-gateway', token), null);
  // A base64 decoder can accept noncanonical padding bits; the wire token must not.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  for (const last of alphabet) {
    const changed = token.slice(0, -1) + last;
    if (changed !== token) assert.equal(verify(key, changed), null);
  }
  console.log('     id lengths 1/63/64 accepted; all 63 MAC last-character mutations refused; rotation=null');
});
await test('tokens: invalid or empty key/id refused without stored state', () => {
  for (const bad of ['', null, undefined, 1, NaN, {}, []]) {
    assert.throws(() => derive(bad, 'atlas'), /gateway key/);
    assert.equal(verify(bad, derive(key, 'atlas')), null);
  }
  for (const bad of ['', null, undefined, 1, {}, [], '-a', 'a b', 'a\n', 'é', 'x'.repeat(65), 'x'.repeat(1_000_000)]) {
    assert.throws(() => derive(key, bad), /agent id/);
  }
  console.log('     id lengths 0/65/1000000 refused; empty/null/undefined/numeric/NaN/object/array keys refused');
});

let stored = { rev4a: key, deepseek: 'fixture-upstream' };
const environment = { REV4A_API_KEY: 'fixture-master' };
const { isGatewayClient } = load('app/api/provider/auth.ts', {
  crypto: require('node:crypto'), '@/app/api/gateway/provider/keys': { readProviderKeys: () => stored },
  '@/lib/agent-proxy-token': tokens, '@/lib/proxy-usage': usage,
}, { process: { env: environment } });
await test('auth: token id wins over absent, spoofed, malformed and reserved headers', () => {
  for (const header of [null, '', 'beta', 'assistant', 'unknown', 'invalid id', 'a,b']) {
    const caller = isGatewayClient(request(derive(key, 'atlas'), header));
    assert.equal(caller.kind, 'agent');
    assert.equal(caller.agentId, 'atlas');
  }
});
await test('auth: legacy shared/master keys keep header identity; upstream keys never authenticate', () => {
  for (const credential of [key, environment.REV4A_API_KEY]) {
    for (const header of [null, '', 'beta', 'new-agent', 'assistant', 'unknown', 'UNKNOWN', 'Assistant',
      'invalid id', 'a,b', 'a.b', '-a', 'x'.repeat(64), 'x'.repeat(65), 'a_b', 'a-b']) {
      const caller = isGatewayClient(request(credential, header));
      assert.equal(caller.kind, 'legacy');
      assert.equal(caller.agentId, header);
    }
  }
  for (const credential of [null, '', 'wrong', stored.deepseek, derive(stored.deepseek, 'atlas'), derive(environment.REV4A_API_KEY, 'atlas')]) {
    assert.equal(isGatewayClient(request(credential, 'atlas')), null);
  }
});
await test('auth: rotation invalidates old tokens; missing/malformed gateway key denies safely', () => {
  const old = derive(key, 'atlas');
  stored = { rev4a: 'rotated-gateway' };
  assert.equal(isGatewayClient(request(old)), null);
  assert.equal(isGatewayClient(request(derive(stored.rev4a, 'atlas'))).agentId, 'atlas');
  for (const invalid of ['', undefined, null, 12, {}]) {
    stored = { rev4a: invalid };
    assert.equal(isGatewayClient(request(old)), null);
    assert.equal(isGatewayClient(request(null)), null);
    assert.equal(isGatewayClient(request(environment.REV4A_API_KEY, 'beta')).kind, 'legacy');
  }
  stored = { rev4a: key, deepseek: 'fixture-upstream' };
});

const known = ['atlas', 'beta'];
const now = 0;
const upstream = load('app/api/provider/upstream.ts', {
  'better-sqlite3': class {}, '@/lib/costs-db': {}, '@/lib/model-pricing': {},
  '@/lib/proxy-usage': { ...usage, createAgentResolver: () => usage.createAgentResolver({ loadKnown: () => known, now: () => now }) },
});
const metered = [];
const next = { NextResponse: { json: (body) => Response.json(body) } };
let upstreamCalls = 0;
const chat = load('app/api/provider/v1/chat/completions/route.ts', {
  'next/server': next, '@/app/api/provider/auth': { isGatewayClient },
  '@/lib/model-catalogue': { isModelOffered: () => true },
  '@/app/api/gateway/provider/keys': { readProviderKeys: () => stored },
  '@/app/api/provider/upstream': { ...upstream,
    callUpstream: async () => { upstreamCalls++; return Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3 } }); },
    meterBody: (ctx) => metered.push(ctx),
  },
});
const models = load('app/api/provider/v1/models/route.ts', {
  'next/server': next, '@/app/api/provider/auth': { isGatewayClient },
  '@/lib/model-catalogue': { loadOfferedModels: () => [{ id: 'deepseek/example', provider: 'deepseek' }] },
});
await test('chat: header cannot redirect token metering; legacy keeps its figures and resolution', async () => {
  for (const [credential, header, expected] of [
    [derive(key, 'atlas'), 'beta', 'atlas'], [derive(key, 'atlas'), null, 'atlas'],
    [derive(key, 'never-known'), 'beta', 'unknown'], [derive(key, 'assistant'), 'beta', 'unknown'],
    [key, 'beta', 'beta'], [key, 'new-agent', 'new-agent'], [key, null, 'unknown'],
    [environment.REV4A_API_KEY, 'beta', 'beta'], [key, 'assistant', 'unknown'],
  ]) {
    assert.equal((await chat.POST(request(credential, header))).status, 200);
    assert.equal(metered.at(-1).agent, expected);
  }
  const before = upstreamCalls;
  assert.equal((await chat.POST(request(derive('rotated', 'atlas'), 'beta'))).status, 401);
  assert.equal(upstreamCalls, before);
});
await test('models: accepts the same three credentials; rotation rejects a stale token', async () => {
  for (const credential of [derive(key, 'atlas'), key, environment.REV4A_API_KEY]) {
    assert.equal((await (await models.GET(request(credential))).json()).total, 1);
  }
  stored.rev4a = 'rotated-gateway';
  for (const credential of [derive(key, 'atlas'), key, null, 'wrong']) {
    assert.equal((await (await models.GET(request(credential))).json()).total, 0);
  }
  stored.rev4a = key;
});

await test('production lookup: deletion retains historical attribution; rotation revokes the copied token', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE agent_cost_sources (agent_id TEXT, container TEXT); INSERT INTO agent_cost_sources VALUES ('atlas', 'c-atlas')");
    let clock = 0;
    let responseKind = 'json';
    const realUpstream = load('app/api/provider/upstream.ts', {
      'better-sqlite3': function () { return db; }, '@/lib/costs-db': { COSTS_DB_PATH: ':memory:' },
      '@/lib/model-pricing': { priceAt: () => ({ input: 1, output: 2 }) },
      // Preserve the production loadKnown callback: only its clock is controlled.
      '@/lib/proxy-usage': { ...usage, createAgentResolver: (opts) => usage.createAgentResolver({ ...opts, now: () => clock }) },
    }, { setImmediate: (fn) => fn(), TextDecoder, ReadableStream, fetch: async () => {
      if (responseKind === 'transport') throw new Error('fixture transport failure');
      if (responseKind === 'broken-body') return { headers: new Headers(), status: 200, text: async () => { throw new Error('fixture body failure'); } };
      if (responseKind === 'sse') return new Response('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3 } }, { status: responseKind === 'error' ? 429 : 200 });
    } });
    const realChat = load('app/api/provider/v1/chat/completions/route.ts', {
      'next/server': next, '@/app/api/provider/auth': { isGatewayClient },
      '@/lib/model-catalogue': { isModelOffered: () => true },
      '@/app/api/gateway/provider/keys': { readProviderKeys: () => stored },
      '@/app/api/provider/upstream': realUpstream,
    }, { console: { error: () => {} } });
    let dockerCalls = 0;
    let containerExists = true;
    const deletion = load('app/api/agents/[id]/route.ts', {
      'next/server': next, child_process: { execSync: () => { dockerCalls++; containerExists = false; } },
      fs: { existsSync: () => false }, path,
      '@/lib/container': { isValidAgentId: (id) => usage.AGENT_ID_RE.test(id), resolveAgentedContainer: () => containerExists ? 'c-atlas' : null },
      '@/lib/agent-busy': { agentBusyReason: async () => null }, '@/lib/agent-edit': {},
      '@/lib/rev4a-paths': { DB_FILE: '/virtual/events.db' }, '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
      '@/lib/credentials/assignments': { deleteAssignmentsForAgent: () => 0 }, '@/lib/backups-volume': { deleteAgentBackups: async () => [] },
    });
    const copiedToken = derive(key, 'atlas');
    const call = async (credential = copiedToken, header = 'beta') => {
      const response = await realChat.POST(request(credential, header));
      await response.text(); // Finish the real stream meter as well.
      return response.status;
    };
    assert.equal(await call(), 200);
    const removed = await deletion.DELETE(request(null), { params: Promise.resolve({ id: 'atlas' }) });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).success, true);
    assert.equal(dockerCalls, 2);
    for (const time of [59_999, 60_000, 60_001, 86_400_000]) {
      clock = time;
      assert.equal(await call(), 200);
      const sourceRows = db.prepare('SELECT COUNT(*) AS n FROM agent_cost_sources').get().n;
      assert.equal(sourceRows, 1);
      assert.equal(realUpstream.resolveMeterAgent('atlas', true), 'atlas');
      assert.equal(realUpstream.resolveMeterAgent('atlas'), 'atlas');
      console.log(`     after actual deletion t=${time}: sourceRows=${sourceRows} token=atlas legacy=atlas`);
    }
    for (const kind of ['sse', 'error', 'transport', 'broken-body']) {
      responseKind = kind;
      const before = db.prepare('SELECT SUM(calls) AS n FROM proxy_usage_hourly').get().n;
      assert.equal(await call(), kind === 'error' ? 429 : ['transport', 'broken-body'].includes(kind) ? 502 : 200);
      const rows = db.prepare('SELECT agent, SUM(calls) AS calls FROM proxy_usage_hourly GROUP BY agent').all();
      assert.deepEqual(rows, [{ agent: 'atlas', calls: before + 1 }]);
      console.log(`     ${kind}: identity=atlas entries=1`);
    }
    responseKind = 'json';
    assert.equal(await call(derive(key, 'never-known')), 200);
    assert.equal(db.prepare("SELECT calls FROM proxy_usage_hourly WHERE agent='unknown'").get().calls, 1);
    stored.rev4a = 'rotated-gateway';
    const before = db.prepare('SELECT SUM(calls) AS n FROM proxy_usage_hourly').get().n;
    assert.equal(await call(), 401);
    assert.equal(db.prepare('SELECT SUM(calls) AS n FROM proxy_usage_hourly').get().n, before);
    assert.equal(await call(derive(stored.rev4a, 'atlas')), 200);
    console.log('     root rotation: copied token=401 zero new rows; fresh token=200 atlas; never-known=unknown');
  } finally {
    stored.rev4a = key;
    db.close();
  }
});

const writes = new Map();
// All stopped-container staging stays in memory, including failure-path cleanup.
// No real fs mutation, os.tmpdir() dependency, Docker process or host directory.
const stagedFiles = new Map();
let tempSequence = 0;
const stagingFs = {
  mkdtempSync: (prefix) => `${prefix}${++tempSequence}`,
  writeFileSync: (file, body) => { stagedFiles.set(file, body); },
  chmodSync: () => {},
  rmSync: (dir) => { for (const file of stagedFiles.keys()) if (file.startsWith(dir + '/')) stagedFiles.delete(file); },
};
let failRead = false;
let failWrite = false;
let dockerUnavailable = false;
const fleet = 'c-atlas\trunning\tatlas\nc-beta\texited\tbeta';
let containerListing = fleet;
let catalogueStatus = 'available';
let busy = [];
let backup = '';
const config = { agents: { defaults: { model: 'unchanged' } }, padding: 'x'.repeat(400_000), models: { providers: { custom: { apiKey: 'fixture-custom' } } } };
const sync = load('app/api/gateway/sync.ts', {
  child_process: {
    execSync: (command) => {
      if (command.startsWith('docker ps -a')) {
        if (dockerUnavailable) throw new Error('fixture Docker unavailable');
        return containerListing;
      }
      if (command.startsWith('docker ps --filter')) return backup;
      assert.fail(`Unexpected mock command: ${command}`);
    },
    execFileSync: (command, args, options) => {
      assert.equal(command, 'docker'); // Intercepted here; no process is launched.
      if (args[0] === 'inspect') return 'fixture:2026.11.2';
      if (args[0] === 'exec' && args[2] === 'cat') {
        if (failRead) throw new Error('fixture read failure');
        return JSON.stringify(config);
      }
      if (args[0] === 'exec' && args[2] === 'rm') return '';
      if (args[0] === 'exec' && args[1] === '-i') { writes.set(args[2], JSON.parse(options.input)); return ''; }
      if (args[0] === 'cp' && args.at(-1) === '-') {
        if (failRead) throw new Error('fixture read failure');
        return Buffer.from('fixture-tar');
      }
      if (args[0] === 'cp') {
        if (failWrite) throw new Error('fixture write failure');
        assert.ok(stagedFiles.has(args[1]));
        writes.set('c-beta', JSON.parse(stagedFiles.get(args[1]))); return '';
      }
      assert.fail(`Unexpected mock args: ${args}`);
    },
  },
  fs: stagingFs, os: { tmpdir: () => '/virtual/sec20' }, path,
  '@/lib/agent-config-lock': { withAgentConfigLock: async (_, fn) => fn() }, '@/lib/docker-exec': {},
  './provider/keys': { readProviderKeys: () => stored },
  '@/lib/model-catalogue': { bundledCatalogueStatus: () => catalogueStatus, loadOfferedModels: () => [] },
  '@/lib/container-file': { singleFileFromTar: () => ({ body: Buffer.from(JSON.stringify(config)), mode: 0o600 }) },
  '@/lib/docker-utils': { detectProviderGatewayUrl: () => 'http://fixture/api/provider/v1' },
  '@/lib/agent-versions': { parseOpenClawVersion: () => '2026.11.2', isSupportedVersion: () => true },
  '@/lib/agent-update-state': { activeUpdateAgentIds: () => busy },
  '@/lib/agent-recreate-state': { activeRecreateAgentIds: () => [] },
  '@/lib/agent-restore-state': { activeRestoreAgentIds: () => [] },
  '@/lib/agent-edit-state': { activeEditAgentIds: () => [] },
  '@/lib/agent-names': { getAgentDisplayNames: async () => new Map() },
  '@/lib/model-pricing': {}, '@/lib/proxy-usage': usage, '@/lib/agent-proxy-token': tokens,
});
await test('builder: each agent gets its own credential; generic block keeps shared key', () => {
  for (const id of ['atlas', 'beta', 'a.b', 'a', 'x'.repeat(63), 'x'.repeat(64)]) {
    const block = sync.buildRev4aProviderConfig(null, id);
    assert.equal(block.apiKey, derive(key, id));
    assert.equal(block.headers[usage.AGENT_HEADER], id);
  }
  assert.equal(sync.buildRev4aProviderConfig().apiKey, key);
  assert.equal(sync.buildRev4aProviderConfig(null, null).apiKey, key);
  assert.equal(sync.buildRev4aProviderConfig(null, undefined).apiKey, key);
  assert.equal(Object.keys(sync.buildRev4aProviderConfig().headers).length, 0);
  assert.throws(() => sync.buildRev4aProviderConfig(null, ''), /agent id/);
  assert.throws(() => sync.buildRev4aProviderConfig(null, 'invalid id'), /agent id/);
  stored.rev4a = '';
  assert.throws(() => sync.buildRev4aProviderConfig(null, 'atlas'), /gateway key/);
  stored.rev4a = key;
});
await test('sync: an empty install succeeds with or without a gateway key', async () => {
  const previousStored = stored;
  writes.clear();
  containerListing = '';
  try {
    // A missing provider-keys.json reads as {}, not just an empty rev4a entry.
    for (const keys of [{}, { rev4a: '' }, { rev4a: key }]) {
      stored = keys;
      const outcome = await sync.syncAllAgents();
      assert.equal(outcome.ok, true, 'startup must take its success log branch');
      assert.equal(outcome.summary, 'No agent containers to sync.');
      assert.equal(outcome.total, 0);
      assert.equal(outcome.activeModels, 0);
      assert.equal(Object.hasOwn(outcome, 'configError'), false);
      assert.equal(Object.hasOwn(outcome, 'dockerError'), false);
      assert.equal(outcome.synced.length + outcome.stopped.length + outcome.failed.length, 0);
    }
    assert.equal(writes.size, 0);
  } finally {
    stored = previousStored;
    containerListing = fleet;
  }
});
await test('sync: missing key still reports the same error with agents or unreachable Docker', async () => {
  const previousStored = stored;
  stored = {};
  writes.clear();
  try {
    for (const listing of ['c-atlas\trunning\tatlas', 'c-beta\texited\tbeta', fleet]) {
      containerListing = listing;
      for (const unreachable of [false, true]) {
        dockerUnavailable = unreachable;
        const outcome = await sync.syncAllAgents();
        const error = 'REV4A_API_KEY not found in provider-keys.json (add "rev4a" key)';
        assert.equal(outcome.ok, false);
        assert.equal(outcome.configError, error);
        assert.equal(outcome.summary, `Not applied to any agent: ${error}.`);
        assert.equal(outcome.total, 0, 'preserve the existing configError outcome');
        assert.equal(Object.hasOwn(outcome, 'dockerError'), false);
        assert.equal(outcome.synced.length + outcome.stopped.length + outcome.failed.length, 0);
      }
    }
    assert.equal(writes.size, 0);
  } finally {
    stored = previousStored;
    containerListing = fleet;
    dockerUnavailable = false;
  }
});
await test('sync: catalogue-unavailable check keeps its existing behavior with a gateway key', async () => {
  catalogueStatus = 'unavailable';
  writes.clear();
  try {
    for (const listing of ['', fleet]) {
      containerListing = listing;
      const outcome = await sync.syncAllAgents();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.configError, 'models.config.json could not be read, so there is no catalogue to push');
      assert.equal(outcome.total, 0);
    }
    assert.equal(writes.size, 0);
  } finally {
    containerListing = fleet;
    catalogueStatus = 'available';
  }
});
await test('sync: running and stopped agents migrate idempotently without changing other config', async () => {
  for (let pass = 0; pass < 2; pass++) {
    assert.equal((await sync.syncAllAgents()).ok, true);
    for (const id of ['atlas', 'beta']) {
      const written = writes.get(`c-${id}`);
      assert.equal(written.models.providers.rev4a.apiKey, derive(key, id));
      assert.equal(written.models.providers.rev4a.headers[usage.AGENT_HEADER], id);
      assert.deepEqual(written.agents, config.agents);
      assert.deepEqual(written.models.providers.custom, config.models.providers.custom);
      assert.equal(written.padding, config.padding);
    }
    assert.equal(stagedFiles.size, 0);
  }
  stored.rev4a = '';
  writes.clear();
  assert.equal((await sync.syncAllAgents()).ok, false);
  assert.equal(writes.size, 0);
  stored.rev4a = key;
});
await test('sync: failed reads write nothing; failed stopped writes clean staging and report failure', async () => {
  failRead = true;
  writes.clear();
  assert.equal((await sync.syncAllAgents()).failed.length, 2);
  assert.equal(writes.size, 0);
  failRead = false;
  failWrite = true;
  const outcome = await sync.syncAllAgents();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed[0].container, 'c-beta');
  assert.match(outcome.summary, /fixture write failure/);
  assert.equal(stagedFiles.size, 0);
  failWrite = false;
});
await test('sync: busy/backup agents and unavailable Docker cause no writes', async () => {
  writes.clear();
  busy = ['atlas']; backup = 'beta';
  const skipped = await sync.syncAllAgents();
  assert.equal(skipped.ok, false);
  assert.equal(skipped.failed.length, 2);
  assert.equal(writes.size, 0);
  busy = []; backup = ''; dockerUnavailable = true;
  const unavailable = await sync.syncAllAgents();
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.dockerError, /fixture Docker unavailable/);
  assert.equal(writes.size, 0);
  dockerUnavailable = false;
  console.log('     repeated sync preserves 400 KB config; missing key/read failure/busy/backup/unavailable Docker write nothing');
});
console.log(`\n${passed} passed`);
