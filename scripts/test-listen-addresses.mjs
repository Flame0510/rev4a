#!/usr/bin/env node
/** SEC-9B: the pure rules for where the panel and the agents' ports listen, and the port arguments they produce. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { listenAddresses, gatewayFromBridge, formatHostPort, agentPortsListen, docker0Address, hostAddressList, hostHasAddress, hostIpsFromPortArgs, parseSetting } = require('../lib/listen-addresses.js');

function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, process, Error, Number, Set, Object, Array, Map, String,
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`); return dependencies[name]; },
  }, { filename: file });
  return module.exports;
}
const ports = load('lib/agent-ports.ts');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok   ${name}`); };

const linux = { platform: 'linux', gateway: '172.17.0.1', hasIpv6: true, hostAddresses: ['127.0.0.1', '::1', '10.0.0.5', '172.17.0.1', '2001:db8::5'] };
const wildcards = ['0.0.0.0', '::', '::0', '0::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '[::]',
  '0000:0000::0', '0:0:0:0:0:ffff:0:0', '[::FFFF:0.0.0.0]', '::%eth0', '::ffff:0.0.0.0%eth0'];

test('every wildcard spelling is invalid and falls back to local for panel and agents', () => {
  for (const value of wildcards) {
    assert.equal(parseSetting(value).kind, 'invalid', value);
    const host = { ...linux, hostAddresses: [...linux.hostAddresses, value] };
    const panel = listenAddresses(value, host);
    assert.equal(panel.mode, 'local', value);
    assert.deepEqual(panel.addresses, ['127.0.0.1', '::1', '172.17.0.1'], value);
    assert.equal(panel.warnings.length, 1, value);
    const agents = agentPortsListen(value, host.hostAddresses);
    assert.equal(agents.mode, 'local', value);
    assert.equal(agents.hostIp, '127.0.0.1', value);
    assert.equal(agents.warnings.length, 1, value);
  }
});

test('Linux never includes a wildcard gateway in local or one-address listeners', () => {
  for (const gateway of wildcards) {
    for (const value of ['local', '10.0.0.5']) {
      const r = listenAddresses(value, { ...linux, gateway });
      assert.deepEqual(r.addresses, value === 'local' ? ['127.0.0.1', '::1'] : ['127.0.0.1', '::1', '10.0.0.5'], gateway);
      assert.equal(r.warnings.length, 1, gateway);
    }
  }
});

test('unset, empty and "all" listen on every interface (one wildcard listener)', () => {
  for (const v of [undefined, null, '', '  ', 'all', 'ALL', ' All ']) {
    const r = listenAddresses(v, linux);
    assert.equal(r.mode, 'all', String(v));
    assert.deepEqual(r.addresses, []);
    assert.deepEqual([r.warnings, r.errors], [[], []]);
  }
});

test('local on Linux: loopback v4 + v6 + the Docker gateway', () => {
  const r = listenAddresses('local', linux);
  assert.equal(r.mode, 'local');
  assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '172.17.0.1']);
  assert.deepEqual(r.warnings, []);
});

test('local on macOS/Windows: loopback only, no gateway even when one is given', () => {
  for (const platform of ['darwin', 'win32']) {
    const r = listenAddresses('local', { ...linux, platform });
    assert.deepEqual(r.addresses, ['127.0.0.1', '::1']);
    assert.deepEqual(r.warnings, []);
  }
});

test('local without IPv6 skips ::1 without failing', () => {
  assert.deepEqual(listenAddresses('local', { ...linux, hasIpv6: false }).addresses, ['127.0.0.1', '172.17.0.1']);
});

test('local on Linux with no gateway: loopback only and one warning that says agents lose the model', () => {
  for (const gateway of [null, undefined, '']) {
    const r = listenAddresses('local', { ...linux, gateway });
    assert.deepEqual(r.addresses, ['127.0.0.1', '::1']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /agents cannot reach the panel/);
  }
});

test('one IP the host has: that address + loopback + gateway', () => {
  let r = listenAddresses('10.0.0.5', linux);
  assert.equal(r.mode, 'address');
  assert.equal(r.address, '10.0.0.5');
  assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '10.0.0.5', '172.17.0.1']);
  r = listenAddresses('2001:DB8::5', linux);
  assert.equal(r.mode, 'address');
  assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '2001:db8::5', '172.17.0.1']);
  r = listenAddresses('[2001:db8::5]', { ...linux, platform: 'darwin' });
  assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '2001:db8::5']);
});

test('the gateway as the requested IP is not listed twice', () => {
  assert.deepEqual(listenAddresses('172.17.0.1', linux).addresses, ['127.0.0.1', '::1', '172.17.0.1']);
});

test('an address the host does not have: error, falls back to local, never more than asked', () => {
  for (const v of ['192.0.2.9', '2001:db8::99']) {
    const r = listenAddresses(v, linux);
    assert.equal(r.mode, 'local');
    assert.equal(r.address, null);
    assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '172.17.0.1']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /no such address/);
  }
});

test('garbage, wildcard addresses and hostnames: warning, treated as local', () => {
  for (const v of ['everything', 'yes', 'localhost', '0.0.0.0', '::', '999.1.1.1', '10.0.0.5:3740', 'local,all']) {
    const r = listenAddresses(v, linux);
    assert.equal(r.mode, 'local', v);
    assert.deepEqual(r.addresses, ['127.0.0.1', '::1', '172.17.0.1'], v);
    assert.equal(r.warnings.length, 1, v);
    assert.match(r.warnings[0], /REV4A_LISTEN=/);
  }
});

test('the panel never listens on fewer than loopback', () => {
  for (const v of ['local', 'junk', '10.0.0.5', '192.0.2.9']) {
    for (const host of [linux, { ...linux, platform: 'darwin' }, { ...linux, gateway: null }, { platform: 'linux' }, {}]) {
      assert.ok(listenAddresses(v, host).addresses.includes('127.0.0.1'), v);
    }
  }
});

test('gatewayFromBridge reads IPAM.Config[0].Gateway and ignores anything else', () => {
  assert.equal(gatewayFromBridge({ IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] } }), '172.17.0.1');
  for (const bad of [null, {}, { IPAM: {} }, { IPAM: { Config: [] } }, { IPAM: { Config: [{}] } }, { IPAM: { Config: [{ Gateway: 'x' }] } }, { IPAM: { Config: [{ Gateway: '::1' }] } }]) {
    assert.equal(gatewayFromBridge(bad), null);
  }
});

test('formatHostPort brackets IPv6 for the startup line', () => {
  assert.equal(formatHostPort('127.0.0.1', 3740), '127.0.0.1:3740');
  assert.equal(formatHostPort('::1', 3740), '[::1]:3740');
});

test('agent ports setting: all/local/IP/garbage', () => {
  assert.deepEqual(agentPortsListen(undefined), { mode: 'all', hostIp: null, warnings: [] });
  // Explicit `all` is the wildcard (''): a recreate moves a local agent back to every interface.
  assert.deepEqual(agentPortsListen('all'), { mode: 'all', hostIp: '', warnings: [] });
  assert.deepEqual(agentPortsListen('  ALL '), { mode: 'all', hostIp: '', warnings: [] });
  assert.deepEqual(agentPortsListen(''), { mode: 'all', hostIp: null, warnings: [] });
  assert.deepEqual(agentPortsListen('local'), { mode: 'local', hostIp: '127.0.0.1', warnings: [] });
  assert.deepEqual(agentPortsListen('10.0.0.5'), { mode: 'address', hostIp: '10.0.0.5', warnings: [] });
  assert.deepEqual(agentPortsListen('2001:db8::5'), { mode: 'address', hostIp: '2001:db8::5', warnings: [] });
  for (const v of ['nope', '0.0.0.0', '::', '1.2.3']) {
    const r = agentPortsListen(v);
    assert.equal(r.mode, 'local', v);
    assert.equal(r.hostIp, '127.0.0.1', v);
    assert.equal(r.warnings.length, 1, v);
  }
});

test('portMappingArgs: no IP is today\'s argument, byte for byte; one IP prefixes single port and range', () => {
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3700)), ['-p', '3700:3000']);
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3709)), ['-p', '3700-3709:3000-3009']);
  for (const none of [null, undefined, '', '0.0.0.0', '::']) {
    assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3709, none)), ['-p', '3700-3709:3000-3009']);
  }
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3700, '127.0.0.1')), ['-p', '127.0.0.1:3700:3000']);
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3709, '127.0.0.1')), ['-p', '127.0.0.1:3700-3709:3000-3009']);
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3709, '2001:db8::5')), ['-p', '[2001:db8::5]:3700-3709:3000-3009']);
  assert.deepEqual(Array.from(ports.portMappingArgs(3700, 3700, '::1')), ['-p', '[::1]:3700:3000']);
});

test('hostPortsFromArgs still reads the ports of every prefixed form', () => {
  assert.deepEqual(Array.from(ports.hostPortsFromArgs(ports.portMappingArgs(3700, 3702, '127.0.0.1'))), [3700, 3701, 3702]);
  assert.deepEqual(Array.from(ports.hostPortsFromArgs(ports.portMappingArgs(3700, 3702, '::1'))), [3700, 3701, 3702]);
  assert.deepEqual(Array.from(ports.hostPortsFromArgs(ports.portMappingArgs(3705, 3705, '::1'))), [3705]);
});

test('recreate arguments: setting unset keeps every old HostIp; a setting overrides them all', () => {
  const bindings = {
    '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3700' }, { HostIp: '::', HostPort: '3700' }],
    '3001/tcp': [{ HostIp: '192.168.1.2', HostPort: '3701' }],
    '3002/tcp': [{ HostIp: '::1', HostPort: '3702' }],
    '3003/udp': [{ HostIp: '', HostPort: '3703' }],
  };
  const args = (override) => Array.from(ports.portArgsFromBindings(bindings, override)).filter((_, i) => i % 2 === 1);
  assert.deepEqual(args(undefined), ['3700:3000', '192.168.1.2:3701:3001', '[::1]:3702:3002', '3703:3003/udp']);
  assert.deepEqual(args(null), args(undefined));
  assert.deepEqual(args('127.0.0.1'), ['127.0.0.1:3700:3000', '127.0.0.1:3701:3001', '127.0.0.1:3702:3002', '127.0.0.1:3703:3003/udp']);
  assert.deepEqual(args('2001:db8::5'), ['[2001:db8::5]:3700:3000', '[2001:db8::5]:3701:3001', '[2001:db8::5]:3702:3002', '[2001:db8::5]:3703:3003/udp']);
  assert.deepEqual(Array.from(ports.portArgsFromBindings(null, '127.0.0.1')), []);
});

test('gatewayFromBridge scans every IPAM config for an IPv4 gateway', () => {
  assert.equal(gatewayFromBridge({ IPAM: { Config: [{ Subnet: 'fd00::/64', Gateway: 'fd00::1' }, { Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] } }), '172.17.0.1');
  assert.equal(gatewayFromBridge({ IPAM: { Config: [{}, { Gateway: '10.1.0.1' }, { Gateway: '172.17.0.1' }] } }), '10.1.0.1');
});

test('docker0Address reads the interface when Docker gives no gateway; hostAddressList flattens interfaces', () => {
  const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }], docker0: [{ address: 'fe80::1', family: 'IPv6' }, { address: '172.17.0.1', family: 'IPv4' }], eth0: [{ address: '10.0.0.5', family: 'IPv4' }] };
  assert.equal(docker0Address(ifaces), '172.17.0.1');
  assert.equal(docker0Address({ lo: ifaces.lo }), null);
  assert.equal(docker0Address(null), null);
  assert.deepEqual(hostAddressList(ifaces), ['127.0.0.1', 'fe80::1', '172.17.0.1', '10.0.0.5']);
});

test('parseSetting decides "all": blank and any case, never Docker (server.js uses it)', () => {
  for (const v of [undefined, '', '  ', 'all', ' ALL ']) assert.equal(parseSetting(v).kind, 'all');
  assert.equal(parseSetting('x').kind, 'invalid');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /parseSetting\(raw\)\.kind === 'all'/);
  assert.ok(!/\^all\$/i.test(server), 'no second regex for "all"');
});

test('agent ports: an IP the host lacks degrades to 127.0.0.1 with one warning (never more exposed, never a failing run)', () => {
  const host = ['127.0.0.1', '10.0.0.5', '2001:db8::5'];
  assert.deepEqual(agentPortsListen('10.0.0.5', host), { mode: 'address', hostIp: '10.0.0.5', warnings: [] });
  assert.equal(agentPortsListen('2001:DB8::5', host).hostIp, '2001:db8::5');
  for (const v of ['192.0.2.9', '2001:db8::99']) {
    const r = agentPortsListen(v, host);
    assert.deepEqual([r.mode, r.hostIp, r.warnings.length], ['local', '127.0.0.1', 1], v);
    assert.match(r.warnings[0], /no such address/);
  }
  assert.equal(agentPortsListen('127.0.0.2', host).hostIp, '127.0.0.2', 'loopback always exists');
  assert.equal(agentPortsListen('::1', []).hostIp, '::1');
  assert.equal(agentPortsListen('local', host).hostIp, '127.0.0.1');
  assert.equal(agentPortsListen(undefined, host).hostIp, null);
  assert.equal(hostHasAddress('10.0.0.9', host), false);
});

test('hostIpsFromPortArgs lists the addresses -p publishes on, none for wildcards', () => {
  const args = ['-p', '3700:3000', '-p', '10.0.0.5:3701:3001', '-p', '[2001:db8::5]:3702-3704:3002-3004', '-p', '[::1]:3705:3005/udp', '-p', '0.0.0.0:3706:3006', '-p', '127.0.0.1:3707:3007/tcp'];
  assert.deepEqual(hostIpsFromPortArgs(args), ['10.0.0.5', '2001:db8::5', '::1', '127.0.0.1']);
});

// agentPortsHostIp reads .env first (a Config change counts at the next Recreate), then the environment.
{
  const fsMock = { readFileSync: () => fsMock.content };
  const server = (content) => {
    fsMock.content = content;
    const mod = load('lib/agent-ports-server.ts', {
      fs: fsMock, os: { networkInterfaces: () => ({ lo: [{ address: '127.0.0.1' }, { address: '::1' }], eth0: [{ address: '10.0.0.5' }] }) }, '@/lib/docker-socket': {}, '@/lib/rev4a-paths': { ENV_FILE: '/virtual/.env' },
      '@/lib/env-file': require('../lib/env-file.js'), './listen-addresses': require('../lib/listen-addresses.js'), './domain.js': require('../lib/domain.js'),
      './agent-ports': {}, './file-lock': {},
    });
    return mod;
  };
  test('agentPortsHostIp: .env wins over a stale environment; empty entry falls back; unset is "all"', () => {
    const saved = process.env.REV4A_AGENT_PORTS_LISTEN;
    try {
      delete process.env.REV4A_AGENT_PORTS_LISTEN;
      assert.equal(server('').agentPortsHostIp(), null);
      assert.equal(server('REV4A_AGENT_PORTS_LISTEN=local\n').agentPortsHostIp(), '127.0.0.1');
      process.env.REV4A_AGENT_PORTS_LISTEN = 'local';
      assert.equal(server('REV4A_AGENT_PORTS_LISTEN=all\n').agentPortsHostIp(), '', 'explicit all = wildcard');
      assert.equal(server('REV4A_AGENT_PORTS_LISTEN=\n').agentPortsHostIp(), '127.0.0.1');
      assert.equal(server('PORT=1\n').agentPortsHostIp(), '127.0.0.1');
      fsMock.readFileSync = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
      assert.equal(server('').agentPortsHostIp(), '127.0.0.1');
    } finally {
      if (saved === undefined) delete process.env.REV4A_AGENT_PORTS_LISTEN; else process.env.REV4A_AGENT_PORTS_LISTEN = saved;
    }
  });
}

// SEC-9B fixes: a cleared .env entry must win over the launcher's stale copy; a missing host IP is refused.
{
  const fsMock = { readFileSync: () => fsMock.content };
  const mod = () => load('lib/agent-ports-server.ts', {
    fs: fsMock, os: { networkInterfaces: () => ({ lo: [{ address: '127.0.0.1' }], eth0: [{ address: '10.0.0.5' }] }) },
    '@/lib/docker-socket': {}, '@/lib/rev4a-paths': { ENV_FILE: '/virtual/.env' },
    '@/lib/env-file': require('../lib/env-file.js'), './listen-addresses': require('../lib/listen-addresses.js'), './domain.js': require('../lib/domain.js'),
    './agent-ports': {}, './file-lock': {},
  });
  test('clearing REV4A_AGENT_PORTS_LISTEN in .env takes effect without a restart (the launcher\'s copy is stale)', () => {
    const saved = [process.env.REV4A_AGENT_PORTS_LISTEN, process.env.REV4A_DOTENV_KEYS];
    try {
      // The launcher copied "local" from .env and named the key; the entry has since been cleared.
      process.env.REV4A_AGENT_PORTS_LISTEN = 'local';
      process.env.REV4A_DOTENV_KEYS = 'PORT,REV4A_AGENT_PORTS_LISTEN';
      fsMock.content = 'PORT=3740\n';
      assert.equal(mod().readAgentPortsListenSetting(), undefined);
      assert.equal(mod().agentPortsHostIp(), null);
      fsMock.content = 'PORT=3740\nREV4A_AGENT_PORTS_LISTEN=\n';
      assert.equal(mod().agentPortsHostIp(), null);
      // A value that came from the service itself (not in .env at boot) still counts.
      process.env.REV4A_DOTENV_KEYS = 'PORT';
      assert.equal(mod().agentPortsHostIp(), '127.0.0.1');
      // Set in .env now: .env wins.
      fsMock.content = 'REV4A_AGENT_PORTS_LISTEN=10.0.0.5\n';
      assert.equal(mod().agentPortsHostIp(), '10.0.0.5');
    } finally {
      for (const [k, v] of [['REV4A_AGENT_PORTS_LISTEN', saved[0]], ['REV4A_DOTENV_KEYS', saved[1]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  test('agentPortsHostIp: an address the host lacks gives 127.0.0.1; assertPortArgsHostIps refuses a missing one, loopback and wildcards pass', () => {
    fsMock.content = 'REV4A_AGENT_PORTS_LISTEN=192.0.2.9\n';
    assert.equal(mod().agentPortsHostIp(), '127.0.0.1');
    const { assertPortArgsHostIps } = mod();
    assertPortArgsHostIps(['-p', '3700:3000', '-p', '127.0.0.1:3701:3001', '-p', '[::1]:3702:3002', '-p', '10.0.0.5:3703:3003', '-p', '0.0.0.0:3704:3004']);
    assert.throws(() => assertPortArgsHostIps(['-p', '192.0.2.9:3700:3000']), /192\.0\.2\.9, which this host does not have\. Nothing was changed/);
    assert.throws(() => assertPortArgsHostIps(['-p', '[2001:db8::99]:3700-3702:3000-3002']), /2001:db8::99/);
  });
}

{
  // Load only the two listener functions. The server entry point is never evaluated.
  const ast = ts.createSourceFile('server.js', fs.readFileSync(path.join(root, 'server.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['listenOn', 'startListeners'].includes(node.name?.text))
    .map(node => node.getText(ast)).join('\n');
  const gatewayAddress = '172.17.0.1';
  function fixture({ gateway = gatewayAddress, failBinds = 0, mode = 'local', platform = 'linux' } = {}) {
    const env = { REV4A_LISTEN: mode };
    const warnings = [];
    const listens = [];
    let retries = 0;
    let lookups = 0;
    let retry;
    const start = vm.runInNewContext(`${source}\nstartListeners`, {
      process: { env, platform },
      os: { networkInterfaces: () => ({ lo: [{ address: '127.0.0.1' }] }) },
      PORT: 3740, TERMINAL_SECRET: 'fake', TERMINAL_PATH: '/terminal', TERMINAL_WS_PORT: 3741,
      hostAddressList, parseSetting, listenAddresses, formatHostPort,
      dockerGateway: async () => { lookups++; return gateway; },
      console: { log() {}, error() {}, warn: message => warnings.push(message) },
      setInterval: (fn, ms) => {
        assert.equal(ms, 30_000);
        retries++;
        return retry = { tick: fn, unref() {} };
      },
      clearInterval: timer => { assert.equal(timer, retry); retry = undefined; },
    });
    const makeServer = () => Object.assign(new EventEmitter(), {
      listen({ host }, done) {
        listens.push(host);
        if (host === gatewayAddress && failBinds-- > 0) {
          this.emit('error', Object.assign(new Error('Address unavailable'), { code: 'EADDRNOTAVAIL' }));
        } else {
          done();
        }
      },
    });
    return { start: () => start(makeServer(), makeServer), env, warnings, listens,
      get lookups() { return lookups; }, get retries() { return retries; }, get retry() { return retry; } };
  }
  const retrying = fixture({ failBinds: 2 });
  const servers = await retrying.start();
  assert.equal(servers.length, 1);
  assert.deepEqual(JSON.parse(retrying.env.REV4A_LISTEN_STATE).addresses, ['127.0.0.1']);
  assert.equal(retrying.retries, 1);
  await retrying.retry.tick();
  assert.match(retrying.warnings.at(-1), /EADDRNOTAVAIL.*will retry/);
  await retrying.retry.tick();
  assert.equal(servers.length, 2);
  assert.equal(retrying.retry, undefined);
  assert.deepEqual(JSON.parse(retrying.env.REV4A_LISTEN_STATE).addresses, ['127.0.0.1', gatewayAddress]);
  const listening = fixture();
  await listening.start();
  assert.equal(listening.retries, 0);
  const unknown = fixture({ gateway: null });
  await unknown.start();
  assert.equal(unknown.retries, 1);
  for (const opts of [{ mode: 'all' }, { platform: 'darwin' }]) {
    const other = fixture(opts);
    await other.start();
    assert.equal(other.lookups, 0);
    assert.equal(other.retries, 0);
  }
  passed++;
  console.log('ok   Linux gateway bind failures retry until listening and then clear the interval');
}

console.log(`\n${passed} tests passed`);
