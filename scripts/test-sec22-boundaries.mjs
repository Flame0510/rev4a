#!/usr/bin/env node
/** SEC-22 boundaries: isolated route/functions, mocked processes/network, temporary .env only.
 * Never runs the CLI entrypoint, server, daemon or Docker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const envFile = require('../lib/env-file.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}
function load(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    Buffer, Response, Headers, ReadableStream, TextDecoder, Error, TypeError, console,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`);
      return dependencies[name];
    }, ...globals,
  }, { filename: file });
  return module.exports;
}
const next = { NextResponse: { json: (body, opts) => Response.json(body, opts) } };
const request = (body) => ({ json: async () => body, headers: new Headers() });

await test('PP-02 saves reject every control before trimming or mutating/syncing keys', async () => {
  let writes = 0;
  let syncs = 0;
  let stored = { deepseek: 'previous' };
  const route = load('app/api/gateway/provider/route.ts', {
    'next/server': next, child_process: { execSync: () => assert.fail('No processes') },
    './keys': { readProviderKeys: () => ({ ...stored }), writeProviderKeys: (keys) => { stored = keys; writes++; } },
    '../sync': { syncAllAgents: async () => { syncs++; return { ok: true }; } },
    '@/lib/docker-utils': { detectProviderGatewayUrl: () => 'http://mock' },
    '@/lib/model-pricing': {}, '@/lib/model-details': {}, '@/lib/provider-labels': { PROVIDER_LABELS: {} },
    '@/lib/model-catalogue': {}, '@/lib/openrouter-pricing': {},
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
  });
  for (const control of [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), '\x7f']) {
    for (const apiKey of [`sk-a${control}b`, `${control}sk-ab`, `sk-ab${control}`, control]) {
      const res = await route.POST(request({ provider: 'deepseek', apiKey }));
      assert.equal(res.status, 400);
      assert.equal(stored.deepseek, 'previous');
    }
  }
  assert.equal(writes, 0); assert.equal(syncs, 0);
  assert.equal((await route.POST(request({ provider: 'deepseek', apiKey: '  normal-key  ' }))).status, 200);
  assert.equal(stored.deepseek, 'normal-key');
  assert.equal(writes, 1); assert.equal(syncs, 1);
  assert.equal((await route.POST(request({ provider: 'deepseek', apiKey: '  ' }))).status, 200);
  assert.equal(stored.deepseek, undefined);
});

function upstreamHarness(fetch, globals = {}, usage = {}) {
  return load('app/api/provider/upstream.ts', {
    'better-sqlite3': class { constructor() { assert.fail('No database'); } },
    '@/lib/costs-db': { COSTS_DB_PATH: '/mock/costs.db' }, '@/lib/model-pricing': {},
    '@/lib/proxy-usage': { createAgentResolver: () => () => 'unknown', ...usage },
  }, { fetch, setImmediate: () => assert.fail('No metering side effects'), ...globals });
}
function chatHarness(upstream, storedKey) {
  const logs = [];
  const route = load('app/api/provider/v1/chat/completions/route.ts', {
    'next/server': next, '@/app/api/provider/auth': { isGatewayClient: () => true },
    '@/lib/model-catalogue': { isModelOffered: () => true },
    '@/app/api/gateway/provider/keys': { readProviderKeys: () => ({ deepseek: storedKey }) },
    '@/app/api/provider/upstream': { ...upstream,
      resolveMeterAgent: () => 'unknown', recordProxyCall: () => {}, meterBody: () => {},
    }, '@/lib/proxy-usage': { AGENT_HEADER: 'x-rev4a-agent' },
  }, { console: { error: (...args) => logs.push(args) } });
  return { route, logs };
}

await test('PP-02 stored malformed keys fail closed with a fixed 502 and no secret in body/log', async () => {
  let fetched = 0;
  const upstream = upstreamHarness(async () => { fetched++; assert.fail('Malformed keys must never reach fetch'); });
  for (const key of ['sk-a\nb', 'sk-a\rb', 'sk-a\0b', 'sk-a\tb', 'sk-a\x7fb']) {
    const { route, logs } = chatHarness(upstream, JSON.parse(JSON.stringify({ key })).key);
    const res = await route.POST(request({ model: 'deepseek/deepseek-flash', messages: [] }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: { message: 'Gateway error: the upstream request failed', type: 'gateway_error' } });
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes('sk-a'));
    assert.equal(logs[0][1].name, 'TypeError');
  }
  assert.equal(fetched, 0);
});

await test('PP-02 raw fetch/body errors expose only error identifiers in logs', async () => {
  const key = 'sec22-private-key';
  const upstream = upstreamHarness(async () => new Response('{}'));
  for (const bodyFailure of [false, true]) {
    const error = Object.assign(new TypeError(`Headers.append: Bearer ${key} is an invalid header value`), {
      code: 'UND_ERR_TEST', cause: new Error(key),
    });
    const { route, logs } = chatHarness({ ...upstream, callUpstream: async () => {
      if (!bodyFailure) throw error;
      return { headers: new Headers(), status: 200, text: async () => { throw error; } };
    } }, key);
    const res = await route.POST(request({ model: 'deepseek/deepseek-flash' }));
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes(key));
    assert.ok(!JSON.stringify(logs).includes(key));
    assert.deepEqual(JSON.parse(JSON.stringify(logs[0][1])), { name: 'TypeError', code: 'UND_ERR_TEST' });
  }
});

await test('PP-02 diagnostics discard arbitrary throws, stacks, causes and non-identifier metadata', () => {
  const upstream = upstreamHarness(() => assert.fail('No fetch'));
  for (const error of ['sk-a\nb', null, { name: 'sk-a\nb', code: { message: 'private' }, stack: 'private', cause: 'private' }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(upstream.upstreamErrorDetails(error))), { name: 'Error' });
  }
});

await test('PP-02 stream read failures expose a fixed error and safe log identifiers', async () => {
  const key = 'sec22-private-key';
  const logs = [];
  const upstream = upstreamHarness(() => assert.fail('No fetch'), {
    console: { error: (...args) => logs.push(args) }, setImmediate: () => {},
  }, { createSseUsageParser: () => ({ push: () => {}, end: () => null }) });
  const body = new ReadableStream({ pull(controller) {
    controller.error(new TypeError(`Bearer ${key} failed`));
  } });
  await assert.rejects(upstream.meterStream(body, {}, 200).getReader().read(), {
    message: 'Gateway error: the upstream request failed',
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].name, 'TypeError');
  assert.ok(!JSON.stringify(logs).includes(key));
});

await test('PP-02 valid upstream requests and local model discovery retain their behavior', async () => {
  let fetched = 0;
  const upstream = upstreamHarness(async (_url, opts) => {
    fetched++;
    assert.equal(opts.headers.Authorization, 'Bearer normal-key');
    return new Response('{"choices":[]}');
  });
  const { route } = chatHarness(upstream, 'normal-key');
  assert.equal((await route.POST(request({ model: 'deepseek/deepseek-flash' }))).status, 200);
  let authenticated = true;
  const models = load('app/api/provider/v1/models/route.ts', {
    'next/server': next, '@/app/api/provider/auth': { isGatewayClient: () => authenticated },
    '@/lib/model-catalogue': { loadOfferedModels: () => [{ id: 'deepseek/test', provider: 'deepseek' }] },
  }, { fetch: () => assert.fail('Models must stay local') });
  assert.equal((await (await models.GET(request())).json()).total, 1);
  authenticated = false;
  assert.equal((await (await models.GET(request())).json()).total, 0);
  assert.equal(fetched, 1);
});

function spawnHarness() {
  let child;
  let spawns = 0;
  const timers = new Set();
  const timeout = require('../lib/exec-timeout.js');
  const docker = load('lib/docker-exec.ts', {
    child_process: {
      execFile: () => assert.fail('No execFile/probe expected'),
      spawn: (cmd) => {
        assert.equal(cmd, 'docker'); spawns++;
        child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = new EventEmitter(); child.stdin.end = (input) => { child.input = input; };
        child.kills = [];
        child.kill = (signal) => { child.kills.push(signal); return true; };
        return child;
      },
    }, util: require('node:util'), '@/lib/docker-socket': { resolveDockerSocket: () => '/mock/docker.sock' },
    './exec-timeout': { ...timeout, unwrappedContainers: () => new Set() },
  }, { process: { env: {} }, setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn) });
  return { run: (opts) => docker.dockerExecWithInput('sec22-test', ['cat'], 'input', opts),
    get child() { return child; }, get spawns() { return spawns; }, timers };
}

await test('CF-01 exactly maxBuffer combined bytes succeeds, including multibyte output and stderr', async () => {
  for (const [out, err, limit] of [['abcd', '', 4], ['ab', 'cd', 4], ['é', '', 2], ['', '', 0]]) {
    const h = spawnHarness(); const result = h.run({ maxBuffer: limit });
    h.child.stdout.emit('data', Buffer.from(out)); h.child.stderr.emit('data', Buffer.from(err));
    h.child.emit('close', 0);
    assert.equal(await result, out);
    assert.equal(h.child.input, 'input'); assert.equal(h.child.kills.length, 0); assert.equal(h.timers.size, 0);
  }
});

await test('CF-01 +1 byte on either stream kills once, clears the timer, ignores late events and never retries', async () => {
  for (const stream of ['stdout', 'stderr']) {
    for (const limit of [0, 4, 1024 * 1024]) {
      const h = spawnHarness();
      const result = h.run(limit === 1024 * 1024 ? undefined : { maxBuffer: limit });
      h.child.stdout.emit('data', Buffer.alloc(limit, 97));
      h.child[stream].emit('data', Buffer.from('b'));
      assert.deepEqual(h.child.kills, ['SIGKILL']); assert.equal(h.timers.size, 0);
      // A fake missing-wrapper message after the kill must not launch a fallback/probe.
      h.child.stderr.emit('data', Buffer.from('timeout: not found'));
      h.child.stdout.emit('data', Buffer.alloc(32));
      h.child.emit('close', 127); h.child.emit('error', new Error('late error'));
      await assert.rejects(result, { message: `docker exec output exceeded ${limit} bytes` });
      assert.equal(h.spawns, 1); assert.equal(h.child.kills.length, 1);
    }
  }
});

await test('CF-01 normal failures and timeouts retain their outcomes and clear timers', async () => {
  const exited = spawnHarness(); const failure = exited.run({ maxBuffer: 20 });
  exited.child.stderr.emit('data', Buffer.from('normal error'));
  exited.child.emit('close', 1);
  await assert.rejects(failure, { message: 'normal error' });
  assert.equal(exited.timers.size, 0); assert.equal(exited.child.kills.length, 0);
  const timed = spawnHarness(); const timeout = timed.run({ timeoutMs: 5 });
  for (const fire of [...timed.timers]) fire();
  timed.child.emit('close', 0);
  await assert.rejects(timeout, { message: 'docker exec timed out after 5ms' });
  assert.equal(timed.timers.size, 0); assert.deepEqual(timed.child.kills, ['SIGKILL']);
  const broken = spawnHarness(); const error = broken.run();
  broken.child.emit('error', new Error('spawn failed'));
  broken.child.emit('close', 0);
  await assert.rejects(error, { message: 'spawn failed' });
  assert.equal(broken.timers.size, 0);
});

const ports = load('lib/agent-ports.ts');
function recreateHarness(held = new Map()) {
  const calls = [];
  const dependencies = {
    '@/lib/docker-socket': {},
    '@/lib/agent-images': { runDocker: async (args) => calls.push(args) },
    '@/lib/agent-ports': ports,
    '@/lib/agent-ports-server': { getHostPortHolders: async () => held, describeHolder: (h) => h.name },
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
  };
  for (const name of ['container', 'backups-volume', 'cold-backup', 'agent-readiness', 'agent-recreate-state', 'agent-busy', 'agent-stop']) {
    dependencies[`@/lib/${name}`] = {};
  }
  dependencies['@/app/api/gateway/sync'] = {};
  return { calls, ...load('lib/agent-recreate.ts', dependencies) };
}
await test('LC-01 recreates keep specific IPv4/IPv6, LAN, UDP and every distinct binding; wildcard families collapse', async () => {
  const cases = [
    [[{ HostIp: '127.0.0.1', HostPort: '3701' }], '3001/tcp', ['127.0.0.1:3701:3001']],
    [[{ HostIp: '192.168.1.2', HostPort: '3701' }], '3001/tcp', ['192.168.1.2:3701:3001']],
    [[{ HostIp: '::1', HostPort: '3701' }], '3001/tcp', ['[::1]:3701:3001']],
    [[{ HostIp: '::1', HostPort: '3701' }], '3001/udp', ['[::1]:3701:3001/udp']],
    [[{ HostIp: '0.0.0.0', HostPort: '3701' }, { HostIp: '::', HostPort: '3701' }], '3001/tcp', ['3701:3001']],
    [[{ HostIp: '', HostPort: '3701' }], '3001/udp', ['3701:3001/udp']],
    [[{ HostPort: '3701' }], '3001/tcp', ['3701:3001']],
    [[{ HostIp: '127.0.0.1', HostPort: '3701' }, { HostIp: '::1', HostPort: '3701' }], '3001/tcp', ['127.0.0.1:3701:3001', '[::1]:3701:3001']],
    [null, '3001/tcp', []],
  ];
  for (const [bindings, containerPort, expected] of cases) {
    const h = recreateHarness();
    await h.recreateAgentContainer('agent_test', { Id: 'original', HostConfig: {
      NetworkMode: 'bridge', PortBindings: { [containerPort]: bindings },
    } }, 'image');
    const run = h.calls.find((args) => args[0] === 'run');
    const actual = run.filter((_arg, i) => run[i - 1] === '-p');
    assert.deepEqual(Array.from(actual), expected);
  }
});

await test('LC-01 explicit portArgs stay unchanged; address prefixes still participate in pre-removal conflict checks', async () => {
  const h = recreateHarness();
  const portArgs = ['-p', '[::1]:4000:3000/udp'];
  const container = { Id: 'original', HostConfig: { NetworkMode: 'bridge',
    PortBindings: { '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: '3701' }] } } };
  await h.recreateAgentContainer('agent_test', container, 'image', { portArgs });
  const run = h.calls.find((args) => args[0] === 'run');
  assert.equal(run[run.indexOf('-p') + 1], portArgs[1]);
  for (const arg of ['127.0.0.1:3701:3001', '[::1]:3701:3001/udp', '3701:3001']) {
    assert.deepEqual(Array.from(ports.hostPortsFromArgs(['-p', arg])), [3701]);
  }
  assert.deepEqual(Array.from(ports.hostPortsFromArgs(['-p', '[::1]:3700-3702:3000-3002'])), [3700, 3701, 3702]);
  const clash = recreateHarness(new Map([[3701, { name: 'another-container' }]]));
  await assert.rejects(clash.recreateAgentContainer('agent_test', container, 'image'), /already published/);
  assert.equal(clash.calls.length, 0, 'clash must be detected before removal');
});

await test('FPD-01 unused shell-interpolating helper is removed', () => {
  assert.equal(fs.existsSync(path.join(root, 'scripts/remove-auth-profile.js')), false);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-sec22-'));
const ENV_FILE = path.join(tmp, '.env');
const mode = () => fs.statSync(ENV_FILE).mode & 0o777;
const resets = () => { if (fs.existsSync(ENV_FILE)) fs.unlinkSync(ENV_FILE); };
try {
  await test('PP-01 Config save creates 0600 and repairs existing 0644 without changing other content', async () => {
    const route = load('app/api/config/env/route.ts', {
      'next/server': next, fs,
      child_process: { execSync: () => {} },
      '@/lib/rev4a-paths': { ENV_FILE }, '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
      '@/lib/env-file': envFile,
    }, { process: { env: {} } });
    resets();
    assert.equal((await route.PUT(request({ env: { REV4A_TEST: 'new' } }))).status, 200);
    assert.equal(mode(), 0o600);
    fs.writeFileSync(ENV_FILE, '# keep\nGATEWAY_TOKEN=fixture\nREV4A_TEST=old\n');
    fs.chmodSync(ENV_FILE, 0o644);
    assert.equal((await route.PUT(request({ env: { REV4A_TEST: 'changed' } }))).status, 200);
    assert.equal(mode(), 0o600);
    assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), '# keep\nGATEWAY_TOKEN=fixture\nREV4A_TEST=changed\n');
  });

  await test('PP-01 writeEnvVar creates 0600 and repairs existing 0644', () => {
    const paths = load('lib/rev4a-paths.ts', {
      'node:path': path, 'node:os': os, 'node:fs': fs, './env-file.js': envFile,
    }, { process: { env: { REV4A_DATA_DIR: tmp }, platform: process.platform } });
    resets(); paths.writeEnvVar('REV4A_TEST', 'new'); assert.equal(mode(), 0o600);
    fs.chmodSync(ENV_FILE, 0o644); paths.writeEnvVar('REV4A_TEST', 'changed'); assert.equal(mode(), 0o600);
  });

  await test('PP-01 password setup creates 0600 and repairs existing 0644 while preserving existing secrets', async () => {
    for (const existing of [false, true]) {
      resets();
      if (existing) {
        fs.writeFileSync(ENV_FILE, '# keep\nREV4A_TOKEN=fixture\n');
        fs.chmodSync(ENV_FILE, 0o644);
      }
      const route = load('app/api/setup/password/route.ts', {
        'next/server': next, fs, path, crypto: require('node:crypto'),
        '@/lib/rev4a-paths': { ENV_FILE },
        '@/lib/rev4a-auth': { isConfigured: () => false, requireAuthIfConfigured: async () => null },
        '@/lib/env-file': envFile,
      }, { process: { env: {} } });
      assert.equal((await route.POST(request({ password: 'fixture-password' }))).status, 200); // secret-ok
      assert.equal(mode(), 0o600);
      if (existing) assert.ok(fs.readFileSync(ENV_FILE, 'utf8').startsWith('# keep\nREV4A_TOKEN=fixture\n'));
    }
  });

  await test('PP-01 isolated ensureEnv creates/tightens 0600, logs repair once, preserves content, and hardens repair writes', () => {
    const source = fs.readFileSync(path.join(root, 'bin/rev4a.js'), 'utf8');
    const ast = ts.createSourceFile('rev4a.js', source, ts.ScriptTarget.Latest, true);
    const ensure = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'ensureEnv');
    assert.ok(ensure);
    const logs = [];
    const context = vm.createContext({ ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', CONFIG_DIR: tmp,
      readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync,
      realpathSync: fs.realpathSync, renameSync: fs.renameSync, rmSync: fs.rmSync,
      openSync: fs.openSync, closeSync: fs.closeSync,
      statSync: fs.statSync, chmodSync: fs.chmodSync, existsSync: () => true,
      log: (_tag, text) => logs.push(text), seedAgentToken: () => {}, loaderKeysNextWouldLoad: () => [], refuseIfLoaderKeysLeft: () => {}, randomString: () => 'fixture',
      require: (name) => { assert.equal(name, 'fs'); return { symlinkSync: () => {} }; },
      assertEnvValue: envFile.assertEnvValue,
      parseEnvValues: envFile.parseEnvValues, applyEnvEdits: envFile.applyEnvEdits, process: { env: {}, pid: process.pid },
      disableLoaderEnvLines: envFile.disableLoaderEnvLines, removeRuntimeEnvLines: envFile.removeRuntimeEnvLines,
    });
    const run = () => vm.runInContext(`${ensure.getText(ast)}\nensureEnv();`, context);
    resets(); run(); assert.equal(mode(), 0o600);
    const content = '# unchanged\nREV4A_TEST=fixture\n';
    fs.writeFileSync(ENV_FILE, content); fs.chmodSync(ENV_FILE, 0o644);
    run(); assert.equal(mode(), 0o600); assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), content);
    run(); assert.equal(logs.filter((line) => line === 'Tightened .env permissions to 0600').length, 1);
    fs.appendFileSync(ENV_FILE, 'REV4A_SERVER_PID=123\n'); fs.chmodSync(ENV_FILE, 0o644);
    run(); assert.equal(mode(), 0o600); assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), content);
    // Unusual content still receives the permission repair even when content repair is skipped.
    const multiline = 'NOTE="first\nlast"\n';
    fs.writeFileSync(ENV_FILE, multiline); fs.chmodSync(ENV_FILE, 0o644);
    run(); assert.equal(mode(), 0o600); assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), multiline);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} SEC-22 boundary checks passed`);

await test('CF-01 an invalid maxBuffer (NaN, negative, string) falls back to the 1 MiB default instead of disabling the cap', async () => {
  for (const bad of [NaN, -1, '10']) {
    const h = spawnHarness();
    const result = h.run({ maxBuffer: bad });
    h.child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1, 97));
    assert.deepEqual(h.child.kills, ['SIGKILL'], String(bad));
    await assert.rejects(result);
  }
});
