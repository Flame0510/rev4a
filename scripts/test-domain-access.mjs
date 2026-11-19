#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const domain = require('../lib/domain.js');
const caddyfile = require('../lib/caddyfile.js');
const envFile = require('../lib/env-file.js');
const listen = require('../lib/listen-addresses.js');
const hostname = 'rev4a.example.com';
const dataDir = '/fixture';
const config = domain.domainConfig({ REV4A_DOMAIN: hostname });
const credentialPath = `${dataDir}/domain-auth.json`;
const password = 'fixture_password_123456789012345';
const hash = '$2a$12$' + 'a'.repeat(53);
const credentialText = JSON.stringify({ user: 'rev4a', password, hash });
const noEntry = () => Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
const dnsError = (code) => Object.assign(new Error('Resolver fixture'), { code });
const interfaceEntry = (address, internal = false) => ({ address, internal });

function load(file, imports, globals = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Error, Response, URL, TextEncoder, setTimeout, clearTimeout,
    require: (name) => { assert.ok(name in imports, `Unexpected import ${name} in ${file}`); return imports[name]; },
    ...globals,
  });
  return module.exports;
}

function fixture() {
  const files = new Map();
  const reads = [];
  const commands = [];
  const logs = [];
  const probes = [];
  const timers = [];
  let cancellations = 0;
  let caddyError;
  let interfaces = { external: [interfaceEntry('1.1.1.1'), interfaceEntry('2606:4700::1111')] };
  let random = 0;
  let answers = () => [];
  let now = 0;
  const env = { REV4A_TOKEN: 'fixture-bearer', REV4A_PASSWORD: 'fixture-login', REV4A_JWT_SECRET: 'fixture-jwt-secret' };
  const path = require('node:path');
  const jose = require('jose');
  const globals = { process: { env }, console: Object.fromEntries(['log', 'info', 'warn', 'error'].map((key) => [key, (...args) => logs.push(args)])) };
  const forbidden = () => assert.fail('Unexpected mutation or Docker request');
  const getFile = (file) => { if (!files.has(file)) throw noEntry(); return files.get(file); };
  const caddy = load('lib/caddy.js', {
    'node:fs/promises': {
      lstat: async (file) => ({ mode: getFile(file).mode, isFile: () => getFile(file).regular, uid: 0, gid: 0 }),
      readFile: async (file) => { reads.push(file); const entry = getFile(file); if (entry.error) throw entry.error; return entry.text; },
      open: forbidden, unlink: forbidden, rename: forbidden,
    },
    'node:path': path, 'node:crypto': require('node:crypto'),
    'node:child_process': { execFile: (file, args, options, callback) => {
      commands.push({ file, args, options });
      queueMicrotask(() => callback(caddyError, 'v2.11.9', ''));
      return { stdin: { end() {}, on() {} } };
    } },
    './env-file.js': envFile, './file-lock.js': { withFileDirectoryLock: forbidden },
    './docker-socket-path.js': { dockerRequestJson: forbidden }, './caddyfile.js': caddyfile, './domain.js': domain,
  }, globals);
  const addresses = load('lib/domain-status-addresses.ts', {
    'node:net': require('node:net'), 'node:os': { networkInterfaces: () => {
      if (interfaces instanceof Error) throw interfaces;
      return interfaces;
    } },
  }, globals);
  const agentPorts = load('lib/agent-ports-server.ts', {
    fs: { readFileSync: (file) => { const entry = getFile(file); if (entry.error) throw entry.error; return entry.text; } },
    os: { networkInterfaces: () => interfaces }, '@/lib/docker-socket': { dockerFetch: forbidden },
    '@/lib/rev4a-paths': { ENV_FILE: `${dataDir}/.env` }, '@/lib/env-file': envFile, './listen-addresses': listen, './domain.js': domain,
    './agent-ports': {}, './file-lock': { withFileDirectoryLock: forbidden },
  }, globals);
  const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': {} });
  const access = load('lib/remote-access.ts', { './control-ui-navigation': navigation });
  const status = load('lib/domain-status.ts', {
    'node:path': path, './agent-ports-server': agentPorts, './caddy': caddy, './caddyfile': caddyfile, './domain': domain,
    './domain-name': require('../lib/domain-name.js'), './domain-status-addresses': addresses, './listen-addresses': listen, './remote-access': access,
  }, globals);
  const auth = load('lib/rev4a-auth.js', {
    'next/server': { NextResponse: Response }, jose, fs: { existsSync: () => false }, crypto: require('node:crypto'),
    '@/lib/rev4a-paths': { ENV_FILE: '/fixture/.env' }, '@/lib/env-file': envFile,
    './session-fingerprint.js': require('../lib/session-fingerprint.js'),
  }, globals);
  const imports = {
    '@/lib/domain-status': status, '@/lib/domain-status-addresses': addresses, '@/lib/domain': domain,
    '@/lib/domain-name': require('../lib/domain-name.js'),
    '@/lib/caddy': caddy, '@/lib/rev4a-auth': auth, '@/lib/rev4a-paths': { REV4A_DATA: dataDir },
    'node:crypto': { randomBytes: () => Buffer.alloc(8, ++random) },
    'node:dns/promises': { Resolver: class {
      pending = [];
      constructor(options) { assert.equal(options.timeout, 5000); assert.equal(options.tries, 1); }
      async answer(name, type) {
        probes.push({ name, type });
        const result = answers(name, type);
        if (result === 'hang') return new Promise((_, reject) => this.pending.push(reject));
        return result;
      }
      resolve4(name) { return this.answer(name, 'A'); }
      resolve6(name) { return this.answer(name, 'AAAA'); }
      cancel() { cancellations++; for (const reject of this.pending.splice(0)) reject(dnsError('ECANCELLED')); }
    } },
  };
  const routes = Object.fromEntries(['status', 'dns', 'credential'].map((name) => [name,
    load(`app/api/domain/${name}/route.ts`, imports, { ...globals, Date: { now: () => now }, setTimeout: (fn, timeout) => {
      timers.push(timeout);
      return setTimeout(fn, timeout);
    } }).GET,
  ]));
  return {
    files, reads, commands, logs, probes, timers, env, addresses, agentPorts,
    caddyError: (error) => { caddyError = error; },
    interfaces: (value) => { interfaces = value; },
    answers: (fn) => { answers = fn; },
    advance: (ms = 10_000) => { now += ms; },
    cancellations: () => cancellations,
    file: (file, text, mode = 0o644) => files.set(file, { text, mode, regular: true }),
    request: async (name, query = '', authentication = 'bearer') => {
      const url = `http://fixture/api/domain/${name}${query}`;
      const headers = new Headers(authentication === 'bearer' ? { authorization: `Bearer ${env.REV4A_TOKEN}` } : {});
      const cookies = authentication === 'session' ? { get: () => ({ value: auth.signed }) } : undefined;
      if (cookies) auth.signed = await new jose.SignJWT({
        pwf: auth.passwordFingerprint(env.REV4A_PASSWORD, env.REV4A_JWT_SECRET),
      }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(env.REV4A_JWT_SECRET));
      const response = await routes[name]({ url, headers, cookies });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (name === 'credential') assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      return { status: response.status, body: await response.json() };
    },
  };
}

const generated = domain.renderCaddyfile(config, {
  assignments: new Map(), routes: [{ name: 'atlas', hostPort: 3700, dev: false }, { name: 'atlas-3001', hostPort: 3701, dev: true }],
}, hash);
const ask = `{\n  on_demand_tls {\n    ask ${config.askUrl}\n  }\n}\n`;
const imported = 'import rev4a*.caddy\n';

test('all three routes authenticate before reading config, running a command or issuing a DNS query', async () => {
  const f = fixture();
  f.file(credentialPath, credentialText, 0o600);
  f.env.REV4A_DOMAIN = hostname;
  for (const name of ['status', 'dns', 'credential']) {
    const denied = await f.request(name, `?domain=${hostname}&token=${f.env.REV4A_TOKEN}`, 'none');
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: 'Unauthorized' });
  }
  assert.deepEqual([f.reads, f.commands, f.probes, f.logs], [[], [], [], []]);
});

test('status returns the full shape off, saved-before-restart and enabled, using only read operations', async () => {
  const f = fixture();
  f.caddyError(noEntry());
  assert.deepEqual(await f.request('status'), { status: 200, body: {
    domain: null, enabled: false, port: 3740, dataDir,
    caddyMain: config.main, caddyFile: config.file,
    caddy: { installed: false, managedFile: 'missing', imported: false, onDemandAsk: false, askTarget: 'missing' },
    listen: { panel: 'all', agents: 'keep' }, routes: 0, restartPending: false,
    serverAddresses: { ipv4: ['1.1.1.1'], ipv6: ['2606:4700::1111'] },
  } });
  f.caddyError(undefined);
  f.file(`${dataDir}/.env`, `REV4A_DOMAIN=${hostname}\nREV4A_AGENT_PORTS_LISTEN=local\n`);
  f.file(config.main, ask + imported);
  f.file(config.file, generated);
  const pending = (await f.request('status')).body;
  assert.equal(pending.domain, hostname);
  assert.equal(pending.enabled, false);
  assert.equal(pending.restartPending, true);
  f.env.REV4A_DOMAIN = hostname;
  f.env.REV4A_LISTEN = 'local';
  f.env.REV4A_LISTEN_STATE = '{"mode":"local","addresses":["127.0.0.1"]}';
  const active = (await f.request('status')).body;
  assert.deepEqual(active.caddy, { installed: true, managedFile: 'ok', imported: true, onDemandAsk: true, askTarget: 'ok' });
  assert.deepEqual(active.listen, { panel: 'local', agents: 'local' });
  assert.equal(active.routes, 2);
  assert.equal(active.enabled, true);
  assert.equal(active.restartPending, false);
  f.file(`${dataDir}/.env`, `REV4A_DOMAIN=${hostname}\nREV4A_TRUSTED_PROXIES=127.0.0.1,::1\n`);
  assert.equal((await f.request('status')).body.restartPending, true);
  assert.ok(f.commands.every(({ file, args, options }) => file === 'caddy' && args.join() === 'version' && options.timeout === 2000));
  assert.ok(!f.reads.includes(credentialPath));
});

test('status reports the running Caddy paths even with Domain mode off or a pending path change', async () => {
  const f = fixture();
  const caddyMain = '/service/caddy/Caddyfile';
  const caddyFile = '/service/caddy/rev4a.caddy';
  Object.assign(f.env, { REV4A_CADDY_MAIN: caddyMain, REV4A_CADDY_FILE: caddyFile });
  const off = (await f.request('status')).body;
  assert.deepEqual([off.enabled, off.port, off.caddyMain, off.caddyFile], [false, 3740, caddyMain, caddyFile]);
  assert.equal(off.savedSetup, undefined);
  f.env.REV4A_DOMAIN = hostname;
  f.file(`${dataDir}/.env`, 'PORT=7000\nREV4A_CADDY_MAIN=/next/Caddyfile\nREV4A_CADDY_FILE=/next/rev4a.caddy\n');
  const active = (await f.request('status')).body;
  assert.deepEqual([active.enabled, active.port, active.caddyMain, active.caddyFile, active.restartPending],
    [true, 3740, caddyMain, caddyFile, true]);
  assert.deepEqual(active.savedSetup, { port: 7000, caddyMain: '/next/Caddyfile', caddyFile: '/next/rev4a.caddy' });
});

test('status exposes saved setup values for the first setup before restart', async () => {
  const f = fixture();
  f.file(`${dataDir}/.env`, `REV4A_DOMAIN=${hostname}\nPORT=7000\nREV4A_CADDY_MAIN=/saved/Caddyfile\nREV4A_CADDY_FILE=/saved/managed.caddy\n`);
  const { body } = await f.request('status');
  assert.deepEqual([body.enabled, body.restartPending, body.port, body.caddyMain, body.caddyFile],
    [false, true, 3740, config.main, config.file]);
  assert.deepEqual(body.savedSetup, { port: 7000, caddyMain: '/saved/Caddyfile', caddyFile: '/saved/managed.caddy' });
});

test('Domain documentation describes reservations, upgrade behavior and the own-proxy guard', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const ports = read('docs/dev/API-REFERENCE.md').split('### `GET /api/agents/ports`')[1].split('\n---')[0];
  assert.match(ports, /dashboard upstream and routed agent ports/);
  assert.match(ports, /unconfirmed reload/);
  assert.match(ports, /503/);
  const release = read('docs/REV4A.md').split('## 1.30.0')[1].split('\n## ')[0];
  assert.match(release, /Domain setup and Caddy sync require `flock`/);
  assert.match(release, /Recreate keeps a legacy agent's assigned hostname/);
  assert.match(release, /Port allocation pauses if the managed file is unreadable/);
  const assistant = read('app/api/assistant/route.ts');
  assert.match(assistant, /Domain \(your own proxy\) preset requires a tested HTTPS proxy/);
  assert.doesNotMatch(assistant, /Domain always requires a tested HTTPS proxy/);
  const architecture = read('docs/ARCHITECTURE.md');
  assert.match(architecture, /a port if its `docker run` lands between its allocation read and the next sync/);
});

test('status distinguishes bad, pending and missing files and reports absent import or ask', async () => {
  const f = fixture();
  f.env.REV4A_DOMAIN = hostname;
  f.caddyError(new Error('Could not execute'));
  f.file(config.main, ask);
  for (const [content, expected] of [[generated + domain.RELOAD_UNCONFIRMED, 'pending'], [domain.emptyCaddyfile(), 'pending'],
    ['# user-owned', 'unmanaged'], [null, 'missing']]) {
    if (content === null) f.files.delete(config.file);
    else f.file(config.file, content);
    const { status, body } = await f.request('status');
    assert.equal(status, 200);
    assert.deepEqual(body.caddy, { installed: false, managedFile: expected, imported: false, onDemandAsk: true, askTarget: 'ok' });
    assert.equal(body.routes, 0);
  }
  f.file(config.file, generated);
  f.file(config.main, imported);
  assert.equal((await f.request('status')).body.caddy.onDemandAsk, false);
  f.file(config.main, ask.replace(config.askUrl, 'https://auth.example.com/caddy') + imported);
  assert.equal((await f.request('status')).body.restartPending, false, 'a foreign ask endpoint cannot be fixed by restarting Rev4a');
  f.files.get(config.main).error = new Error('Unreadable Caddyfile');
  assert.equal((await f.request('status')).body.caddy.imported, false);
  assert.deepEqual(f.logs, []);
});

test('outdated, invalid and matching Caddy callbacks are independent of saved settings', async (t) => {
  const f = fixture();
  Object.assign(f.env, { REV4A_DOMAIN: hostname, PORT: '7000' });
  const save = (port) => f.file(`${dataDir}/.env`, `REV4A_DOMAIN=${hostname}\nPORT=${port}\n`);
  const callback = (port) => f.file(config.main, ask.replace('3740', String(port)) + imported);
  save(7000);
  for (const [target, expected] of [[3740, 'stale'], [3740, 'stale'], [65536, 'invalid'], [7000, 'ok']]) {
    callback(target);
    const { body } = await f.request('status');
    assert.deepEqual([body.port, body.dataDir], [7000, dataDir]);
    assert.deepEqual([body.caddy.askTarget, body.caddy.onDemandAsk, body.restartPending], [expected, expected === 'ok', false]);
    t.diagnostic(`Running/saved 7000, callback ${target}: askTarget=${body.caddy.askTarget}, onDemandAsk=${body.caddy.onDemandAsk}, restartPending=${body.restartPending}`);
  }
  const savedPorts = [];
  for (const [port, pending] of [[0, false], [1, true], [8080, true], [65535, true], [65536, false]]) {
    save(port);
    const { body } = await f.request('status');
    assert.equal(body.restartPending, pending);
    assert.equal(body.caddy.askTarget, 'ok');
    savedPorts.push(`${port}=${body.restartPending}`);
  }
  t.diagnostic(`Saved port changes, restartPending: ${savedPorts.join(', ')}`);
});

test('a truncated managed file cannot look like an intact zero-agent file', async (t) => {
  const f = fixture();
  f.env.REV4A_DOMAIN = hostname;
  f.file(config.main, ask + imported);
  const render = (routes) => domain.renderCaddyfile(config, { assignments: new Map(), routes });
  const empty = render([]);
  const fixtures = [
    ['header only', empty.split('\n').slice(0, 2).join('\n') + '\n', 'incomplete', 0],
    ['missing wildcard', empty.split(`*.${hostname}`)[0], 'incomplete', 0],
    ['unclosed wildcard', empty.slice(0, -2), 'incomplete', 0],
    ['intact', empty, 'ok', 0],
    ['large intact', render(Array.from({ length: 10_000 }, (_, i) => ({ name: `agent-${i}`, hostPort: 10_000 + i }))), 'ok', 10_000],
  ];
  for (const [label, text, state, count] of fixtures) {
    f.file(config.file, text);
    const started = performance.now();
    const { body } = await f.request('status');
    assert.deepEqual([body.caddy.managedFile, body.routes, body.caddy.imported, body.caddy.onDemandAsk], [state, count, true, true]);
    t.diagnostic(`${label}: managedFile=${body.caddy.managedFile}, routes=${body.routes}, imported=${body.caddy.imported}, onDemandAsk=${body.caddy.onDemandAsk} (${Math.round(performance.now() - started)} ms)`);
  }
  f.interfaces(new Error('Interface lookup unavailable'));
  assert.deepEqual((await f.request('status')).body.serverAddresses, { ipv4: [], ipv6: [] });
});

test('an unreadable .env cannot reuse a stale boot setting for agent ports', async (t) => {
  const f = fixture();
  const file = `${dataDir}/.env`;
  f.file(file, 'REV4A_AGENT_PORTS_LISTEN=all\n');
  f.files.get(file).error = Object.assign(new Error('Fixture permission denied'), { code: 'EACCES' });
  Object.assign(f.env, { REV4A_AGENT_PORTS_LISTEN: 'all', REV4A_DOTENV_KEYS: 'REV4A_AGENT_PORTS_LISTEN' });
  const { body } = await f.request('status');
  const policy = f.agentPorts.currentAgentPortsListen();
  assert.equal(body.listen.agents, 'keep');
  assert.equal(policy.hostIp, null);
  t.diagnostic(`EACCES with .env-loaded all: status agents=${body.listen.agents}, agent policy hostIp=${policy.hostIp}`);
  delete f.env.REV4A_DOTENV_KEYS;
  assert.equal((await f.request('status')).body.listen.agents, 'all');
  assert.equal(f.agentPorts.currentAgentPortsListen().hostIp, '');
});

test('server interfaces exclude private, internal, loopback, link-local, ULA and non-global ranges', (t) => {
  const f = fixture();
  const entries = ['10.0.1.2', '192.168.1.2', '172.31.1.1', '100.64.1.1', '127.0.0.2', '169.254.1.2',
    '0.0.0.0', '224.0.0.1', '192.0.2.5', '198.51.100.5', '203.0.113.1', '240.0.0.1', '::1', '::ffff:127.0.0.1', '::', 'fe80::1234%en0',
    'fd00::1', 'fc12::1', 'ff00::1', '2001:db8::1', '3ffe:ffff::1', '3fff::1', 'bad-ip', '1.1.1.1', '1.1.1.1',
    '2606:4700:0000:0000:0000:0000:0000:1111', '2606:4700::1111'].map((ip) => interfaceEntry(ip));
  f.interfaces({ external: [...entries, interfaceEntry('8.8.8.8', true)] });
  assert.equal(JSON.stringify(f.addresses.serverAddresses()), JSON.stringify({ ipv4: ['1.1.1.1'], ipv6: ['2606:4700::1111'] }));
  t.diagnostic(`With 3ffe:ffff::1 and other reserved fixtures: ${JSON.stringify(f.addresses.serverAddresses())}`);
  f.interfaces({ local: [interfaceEntry('192.168.1.2'), interfaceEntry('fd00::1')] });
  assert.equal(JSON.stringify(f.addresses.serverAddresses()), '{"ipv4":[],"ipv6":[]}');
});

test('DNS validates strictly, checks all four rows and queries a fresh system-resolver wildcard probe', async (t) => {
  const f = fixture();
  for (const query of ['', '?domain=', '?domain=localhost', '?domain=1.2.3.4', '?domain=*.example.com',
    '?domain=https://example.com', '?domain=example.com.', '?domain=example.com&domain=other.com',
    `?domain=${'a'.repeat(300)}.com`]) {
    assert.equal((await f.request('dns', query)).status, 400);
  }
  assert.deepEqual(f.probes, []);
  f.answers((name, type) => {
    if (name === `${hostname}.`) {
      if (type === 'A') return ['1.1.1.1', '1.1.1.1'];
      throw dnsError('ENODATA');
    }
    if (type === 'A') return ['2.2.2.2'];
    return ['2606:4700:0:0:0:0:0:1111'];
  });
  const { status, body } = await f.request('dns', '?domain=%20REV4A.EXAMPLE.COM%20');
  assert.equal(status, 200);
  assert.deepEqual(body.records, [
    { name: hostname, type: 'A', expected: ['1.1.1.1'], found: ['1.1.1.1'], ok: true },
    { name: hostname, type: 'AAAA', expected: ['2606:4700::1111'], found: [], ok: false },
    { name: `*.${hostname}`, type: 'A', expected: ['1.1.1.1'], found: ['2.2.2.2'], ok: false },
    { name: `*.${hostname}`, type: 'AAAA', expected: ['2606:4700::1111'], found: ['2606:4700::1111'], ok: true },
  ]);
  const cached = await f.request('dns', `?domain=${hostname}`);
  assert.deepEqual(cached.body, body);
  assert.equal(f.probes.length, 4);
  f.advance();
  await f.request('dns', `?domain=${hostname}`);
  assert.match(f.probes[2].name, /^rev4a-check-[a-f0-9]{16}\.rev4a\.example\.com\.$/);
  assert.equal(f.probes[2].name, f.probes[3].name);
  assert.notEqual(f.probes[2].name, f.probes[6].name);
  const labels = [];
  const lengths = [];
  for (const size of [62, 63, 64]) {
    labels.push((await f.request('dns', `?domain=${'a'.repeat(size)}.com`)).status);
  }
  for (const size of [206, 207, 208]) {
    const name = [...Array(3).fill('a'.repeat(63)), 'b'.repeat(size - 192)].join('.');
    assert.equal(name.length, size);
    lengths.push((await f.request('dns', `?domain=${name}`)).status);
  }
  assert.deepEqual(labels, [200, 200, 400]);
  assert.deepEqual(lengths, [200, 200, 400]);
  t.diagnostic(`Label lengths 62/63/64: ${labels.join('/')}. Domain lengths 206/207/208: ${lengths.join('/')}. Invalid inputs: 0 queries.`);
  t.diagnostic(`DNS row match flags: ${body.records.map((record) => record.ok).join('/')}. Fresh wildcard after reuse expiry: ${f.probes[2].name !== f.probes[6].name}.`);
});

test('DNS coalesces 24 simultaneous checks, limits unrelated names and reuses results for ten seconds', async (t) => {
  const f = fixture();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.answers(() => held);
  const requests = Array.from({ length: 24 }, (_, index) =>
    f.request('dns', `?domain=${index % 2 ? hostname : hostname.toUpperCase()}`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.probes.length, 4);
  const concurrent = await f.request('dns', '?domain=other.example.com');
  assert.equal(concurrent.status, 429);
  assert.equal(f.probes.length, 4);
  release([]);
  const outcomes = await Promise.all(requests);
  assert.ok(outcomes.every(({ status, body }) => status === 200 && JSON.stringify(body) === JSON.stringify(outcomes[0].body)));
  f.advance(9999);
  assert.deepEqual(await f.request('dns', `?domain=${hostname}`), outcomes[0]);
  assert.equal(f.probes.length, 4);
  assert.equal((await f.request('dns', '?domain=other.example.com')).status, 200);
  assert.deepEqual(await f.request('dns', `?domain=${hostname}`), outcomes[0]);
  assert.equal(f.probes.length, 8);
  f.advance(1);
  assert.equal((await f.request('dns', `?domain=${hostname}`)).status, 200);
  assert.equal(f.probes.length, 12);
  assert.notEqual(f.probes[2].name, f.probes[10].name);
  t.diagnostic('24 simultaneous checks: 4 resolver queries, 24 identical 200 replies. Other hostname while busy: 429. At 9999 ms: reused. At 10000 ms: fresh wildcard.');
});

test('DNS distinguishes missing, unavailable and timed-out answers and leaves NAT results unverified', async (t) => {
  const f = fixture();
  f.answers(() => { throw dnsError('ENOTFOUND'); });
  f.interfaces({ local: [interfaceEntry('192.168.1.2')] });
  assert.ok((await f.request('dns', `?domain=${hostname}`)).body.records.every(({ found, expected, ok }) =>
    !ok && !found.length && !expected.length));
  f.advance();
  f.answers((_name, type) => type === 'A' ? ['1.1.1.1'] : []);
  assert.ok((await f.request('dns', `?domain=${hostname}`)).body.records.every(({ expected, ok }) => !ok && !expected.length));
  f.advance();
  f.answers(() => { throw dnsError('ESERVFAIL'); });
  assert.equal((await f.request('dns', `?domain=${hostname}`)).status, 502);
  f.advance();
  f.answers(() => { throw dnsError('ETIMEOUT'); });
  assert.equal((await f.request('dns', `?domain=${hostname}`)).status, 504);
  f.advance();
  f.answers(() => 'hang');
  const before = f.cancellations();
  const started = performance.now();
  assert.equal((await f.request('dns', `?domain=${hostname}`)).status, 504);
  assert.equal(f.timers.at(-1), 5000);
  assert.ok(f.cancellations() > before);
  t.diagnostic(`Stalled resolver: 504 after ${Math.round(performance.now() - started)} ms. NAT records: unverified.`);
});

test('credential uses session or bearer, returns only user and password, and never logs a secret or file error', async (t) => {
  const f = fixture();
  f.file(credentialPath, credentialText, 0o600);
  assert.equal((await f.request('credential')).status, 404);
  assert.deepEqual(f.reads, []);
  f.env.REV4A_DOMAIN = hostname;
  for (const auth of ['bearer', 'session']) {
    assert.deepEqual(await f.request('credential', '', auth), { status: 200, body: { user: 'rev4a', password } });
  }
  for (const [text, mode] of [[credentialText, 0o644], [`{${password}`, 0o600], [null]]) {
    if (text === null) f.files.delete(credentialPath);
    else f.file(credentialPath, text, mode);
    const response = await f.request('credential');
    assert.deepEqual(response, { status: 404, body: { error: 'Dev-port credential unavailable.' } });
  }
  f.file(credentialPath, credentialText, 0o600);
  f.files.get(credentialPath).regular = false;
  assert.equal((await f.request('credential')).status, 404);
  assert.deepEqual([f.logs, f.commands], [[], []]);
  t.diagnostic('Credential: bearer/session=200, off/corrupt/missing/nonregular/0644=404, no-store and no-referrer, mock logs=0.');
});
