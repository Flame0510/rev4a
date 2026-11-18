import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const domain = require('../lib/domain.js');
const { ASK_PATH, PENDING, agentBase, agentHostPort, buildNameTable, domainConfig, normalizeDomain, readAssignments, renderCaddyfile } = domain;
const { CLIENT_IP_HEADER, SOCKET_PEER_HEADER, parseTrustedProxies, setClientAddressHeaders } = require('../lib/client-address.js');
const envEditor = require('../lib/env-file.js');
const { checkAgentRoute, syncCaddy } = require('../lib/caddy.js');
const { planCaddyfile, setupDomain } = require('../lib/caddy-setup.js');
const { sessionCookieOptions } = await import('../lib/session-cookie.ts');

const env = { REV4A_DOMAIN: 'rev4a.example.com', REV4A_SUPERVISED: '1' };
const config = domainConfig(env);
const dataDir = '/rev4a';
const envFile = dataDir + '/.env';
const authFile = dataDir + '/domain-auth.json';
const hash = '$2a$14$' + 'a'.repeat(53); // Synthetic bcrypt-shaped test value.
const binding = (HostPort, HostIp = '127.0.0.1') => ({ HostIp, HostPort });
const bindings = (control, dev, HostIp) => ({
  '3000/tcp': [binding(control, HostIp)],
  '3001/tcp': [binding(dev, HostIp)],
});
const fleet = [
  { containerName: 'atlas', displayName: 'Atlas', created: '2026-10-01T00:00:00Z', running: true, activeBindings: bindings('3700', '3701') },
  { containerName: 'beacon', displayName: 'Beacon', created: '2026-10-02T00:00:00Z', running: true, activeBindings: { ...bindings('3710', '', '0.0.0.0'), '3009/tcp': [binding('3719', '0.0.0.0')] } },
  { containerName: 'relay', displayName: 'Relay', created: '2026-10-03T00:00:00Z', running: true, activeBindings: bindings('3720', '') },
];
const golden = n => [
  '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup',
  '# Rev4a domain: rev4a.example.com',
  ...(n ? ['# Rev4a agent: atlas atlas atlas'] : []),
  ...(n === 3 ? ['# Rev4a agent: beacon beacon beacon', '# Rev4a agent: relay relay relay'] : []),
  '',
  'rev4a.example.com {',
  '\treverse_proxy 127.0.0.1:3740',
  '}',
  '',
  '*.rev4a.example.com {',
  '\ttls {',
  '\t\ton_demand',
  '\t}',
  '',
  ...(n ? [
    '\t@atlas host atlas.rev4a.example.com',
    '\thandle @atlas {',
    '\t\treverse_proxy 127.0.0.1:3700 {',
    '\t\t\theader_up -X-Forwarded-For',
    '\t\t\theader_up -X-Forwarded-Proto',
    '\t\t\theader_up -X-Forwarded-Host',
    '\t\t}',
    '\t}',
    '',
    '\t@atlas-3001 host atlas-3001.rev4a.example.com',
    '\thandle @atlas-3001 {',
    '\t\tbasic_auth {',
    `\t\t\trev4a ${hash}`,
    '\t\t}',
    '\t\treverse_proxy 127.0.0.1:3701 {',
    '\t\t\theader_up -Authorization',
    '\t\t\theader_up -X-Forwarded-For',
    '\t\t\theader_up -X-Forwarded-Proto',
    '\t\t\theader_up -X-Forwarded-Host',
    '\t\t}',
    '\t}',
    '',
  ] : []),
  ...(n === 3 ? [
    '\t@beacon host beacon.rev4a.example.com',
    '\thandle @beacon {',
    '\t\treverse_proxy 127.0.0.1:3710 {',
    '\t\t\theader_up -X-Forwarded-For',
    '\t\t\theader_up -X-Forwarded-Proto',
    '\t\t\theader_up -X-Forwarded-Host',
    '\t\t}',
    '\t}',
    '',
    '\t@beacon-3009 host beacon-3009.rev4a.example.com',
    '\thandle @beacon-3009 {',
    '\t\tbasic_auth {',
    `\t\t\trev4a ${hash}`,
    '\t\t}',
    '\t\treverse_proxy 127.0.0.1:3719 {',
    '\t\t\theader_up -Authorization',
    '\t\t\theader_up -X-Forwarded-For',
    '\t\t\theader_up -X-Forwarded-Proto',
    '\t\t\theader_up -X-Forwarded-Host',
    '\t\t}',
    '\t}',
    '',
    '\t@relay host relay.rev4a.example.com',
    '\thandle @relay {',
    '\t\treverse_proxy 127.0.0.1:3720 {',
    '\t\t\theader_up -X-Forwarded-For',
    '\t\t\theader_up -X-Forwarded-Proto',
    '\t\t\theader_up -X-Forwarded-Host',
    '\t\t}',
    '\t}',
    '',
  ] : []),
  '\thandle {',
  '\t\trespond 404',
  '\t}',
  '}',
  '',
].join('\n');

test('slug normalization, fallbacks, length and collision namespaces', () => {
  const title = 'x'.repeat(45);
  const examples = [
    ['one', ' Älpha + + Beta ', 'lpha-beta'],
    ['two', '🚀', 'two'],
    ['???', '測試', 'agent'],
    ['device.a', '', 'device-a'],
    ['three', title, 'x'.repeat(40)],
    ['four', title, 'x'.repeat(38) + '-2'],
    ['five', 'server', 'server'],
    ['six', 'server-3009', 'server-3009-2'],
    ['seven', 'server', 'server-2'],
  ];
  const agents = examples.map(([containerName, displayName], i) =>
    ({ containerName, displayName, created: new Date(i).toISOString() }));
  const table = buildNameTable(agents.reverse());
  for (const [name, , expected] of examples) assert.equal(table.assignments.get(name).name, expected);
  assert.deepEqual(table.routes, []);
  assert.equal(normalizeDomain(' ReV4a.Example.COM '), config.domain);
  for (const invalid of ['https://example.com', 'bad.example.com:443', '*.example.com', 'foo.example.com.', '127.0.0.1', 'x.localhost', 'bad{.example.com']) {
    assert.throws(() => normalizeDomain(invalid), /DNS hostname/);
  }
});

test('creation order is deterministic and both slots survive a Recreate and its temporary gap', () => {
  const first = { ...fleet[0], displayName: 'Same', created: '2026-10-01' };
  const second = { ...fleet[1], displayName: 'Same', created: '2026-10-02' };
  const third = { ...fleet[2], displayName: 'Same', created: '2026-10-03' };
  const initial = buildNameTable([third, second, first]);
  assert.deepEqual([...initial.assignments.values()].map(entry => entry.name), ['same', 'same-2', 'same-3']);
  const gap = buildNameTable([second, third], initial.assignments);
  assert.equal(gap.routes.some(route => route.name === 'same'), false);
  const competing = buildNameTable([second, third, { ...fleet[0], containerName: 'newcomer', displayName: 'Same' }], gap.assignments);
  assert.equal(competing.assignments.get('newcomer').name, 'same-4');
  const remembered = readAssignments(renderCaddyfile(config, gap, hash), config.domain);
  const recreated = buildNameTable([second, third, { ...first, created: '2026-10-04' }], remembered);
  assert.deepEqual(recreated, initial);
  const renamed = buildNameTable([{ ...first, displayName: 'New name' }, second, third], recreated.assignments);
  assert.equal(renamed.assignments.get(first.containerName).name, 'new-name');
  assert.equal(renamed.assignments.get(second.containerName).name, 'same-2');
});

test('golden generated Caddyfiles for 0, 1, and 3 agents', () => {
  for (const n of [0, 1, 3]) {
    assert.equal(renderCaddyfile(config, buildNameTable(fleet.slice(0, n)), hash), golden(n));
  }
});

test('checker DNS, slug, port and collision boundaries', t => {
  const accepts = value => {
    try { return Boolean(normalizeDomain(value)); } catch { return false; }
  };
  const labels = [62, 63, 64].map(n => accepts('a'.repeat(n) + '.example.com'));
  const domains = [206, 207, 208].map(n => accepts(('a'.repeat(60) + '.').repeat(3) + 'b'.repeat(n - 187) + '.com'));
  const slugs = [39, 40, 41].map(n => agentBase({ displayName: 'a'.repeat(n) }).length);
  const ports = [0, 1, 65535, 65536].map(n => agentHostPort({ running: true, activeBindings: bindings(String(n), '') }, 3000));
  assert.deepEqual(labels, [true, true, false]);
  assert.deepEqual(domains, [true, true, false]);
  assert.deepEqual(slugs, [39, 40, 40]);
  assert.deepEqual(ports, [null, 1, 65535, null]);
  assert.ok(['bad\nname.example', 'bad{.example', 'bad#.example', '*.example.com', '127.0.0.1', '/etc/*.caddy']
    .every(value => !accepts(value)));
  assert.equal(domainConfig({ REV4A_DOMAIN: '   ' }), null);
  assert.equal(agentBase({ displayName: '測試', containerName: 'Fallback' }), 'fallback');
  assert.deepEqual(buildNameTable([{ ...fleet[0], activeBindings: {
    '2999/tcp': [binding('4800')], '3010/tcp': [binding('4810')],
  } }]).routes, []);
  const duplicates = Array.from({ length: 450 }, (_, i) => ({ id: String(i).padStart(3, '0'), containerName: 'agent-' + i, displayName: 'Duplicate' }));
  assert.equal(new Set([...buildNameTable(duplicates).assignments.values()].map(value => value.name)).size, 450);
  t.diagnostic(`DNS labels 62/63/64: ${labels}; domain lengths 206/207/208: ${domains}; slug lengths: ${slugs}; ports: ${JSON.stringify(ports)}; collision names: 450`);
});

test('creation timestamps are parsed and ties use the container ID', t => {
  const shared = { displayName: 'Duplicate' };
  const stamp = '2026-10-01T12:00:00';
  const table = buildNameTable([
    { ...shared, id: '001', containerName: 'later', created: stamp + '.001Z' },
    { ...shared, id: '003', containerName: 'alphabetical-first', created: stamp + 'Z' },
    { ...shared, id: '002', containerName: 'earlier', created: stamp + '.000Z' },
  ]);
  const slots = ['earlier', 'alphabetical-first', 'later'].map(name => table.assignments.get(name).name);
  assert.deepEqual(slots, ['duplicate', 'duplicate-2', 'duplicate-3']);
  t.diagnostic(`earlier (.000Z): ${slots[0]}; tied (higher ID): ${slots[1]}; later (.001Z): ${slots[2]}`);
});

test('private bindings, non-TCP, invalid ports, and conflicting stopped claims cannot target other loopback routes', () => {
  const active = {
    ...fleet[0], activeBindings: {
      '3000/tcp': [binding('3740')],
      '3001/tcp': [binding('8000', '192.0.2.1')],
      '3002/tcp': [binding('8001', '::1')],
      '3003/tcp': [binding('65536')],
      '3004/udp': [binding('8002')],
      '3005/tcp': [binding('8003', '0.0.0.0')],
    },
  };
  const stopped = { ...fleet[1], running: false, activeBindings: bindings('8003', '') };
  const table = buildNameTable([active, stopped]);
  assert.deepEqual(table.routes, [{ name: 'atlas-3005', hostPort: 8003, dev: true }]);
  assert.deepEqual(buildNameTable([{ ...fleet[0], activeBindings: null, bindings: bindings('9000', '') }]).routes, []);
});

const mainImport = 'import /etc/caddy/rev4a.caddy\n';
function inspectAgent(agent) {
  return {
    Id: agent.id ?? agent.containerName,
    Name: '/' + agent.containerName,
    Config: { Labels: { AGENT_ID: agent.containerName }, Env: ['OTHER=fake', 'AGENT_NAME=' + agent.displayName] },
    Created: agent.created,
    State: { Running: agent.running },
    HostConfig: { PortBindings: agent.bindings ?? agent.activeBindings },
    NetworkSettings: { Ports: agent.activeBindings },
  };
}
function mockRuntime({ initial = {}, agents = fleet, failure, missing = false, list, hashOutput = hash } = {}) {
  const operations = [];
  const commands = [];
  const messages = [];
  const files = new Map(Object.entries({ [config.main]: mainImport, ...initial })
    .map(([file, value]) => [file, typeof value === 'string' ? { text: value, mode: 0o644 } : value]));
  const entry = file => {
    if (!files.has(file)) throw Object.assign(new Error('missing ' + file), { code: 'ENOENT' });
    return files.get(file);
  };
  const io = {
    lstat: async file => ({ ...entry(file), uid: 1, gid: 2, isFile: () => true }),
    readFile: async file => entry(file).text,
    open: async (file, flags, mode) => {
      assert.equal(flags, 'wx');
      assert.ok(!files.has(file));
      operations.push(['open', file, mode]);
      files.set(file, { text: '', mode });
      return {
        writeFile: async text => { entry(file).text = text; },
        chmod: async value => { entry(file).mode = value; },
        chown: async (uid, gid) => { Object.assign(entry(file), { uid, gid }); },
        sync: async () => {},
        close: async () => {},
      };
    },
    rename: async (source, file) => {
      assert.equal(dirname(source), dirname(file));
      operations.push(['rename', source, file, entry(source).mode]);
      files.set(file, entry(source));
      files.delete(source);
    },
    unlink: async file => { operations.push(['unlink', file]); files.delete(file); },
    copyFile: async (source, destination, flag) => {
      assert.equal(flag, 1);
      assert.ok(!files.has(destination));
      operations.push(['copy', source, destination]);
      files.set(destination, { ...entry(source) });
    },
    mkdir: async file => { operations.push(['mkdir', file]); },
    realpath: async file => file,
    mkdtemp: async () => '/tmp/caddy-1',
    rmdir: async file => { operations.push(['rmdir', file]); },
  };
  const run = async (program, args, options) => {
    commands.push({ program, args, input: options?.input });
    if (program === 'caddy' && args[0] === 'version' && missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (program === 'curl') files.set(args.at(-1), { text: 'download fixture' });
    if (program === 'gpg') files.set(args.at(-2), { text: 'keyring fixture' });
    if (program === 'apt-get' && args.includes('caddy')) {
      missing = false;
      files.set(config.main, { text: ':80 {\n\trespond "Package default"\n}\n', mode: 0o644 });
    }
    if (args[0] === failure) throw new Error('rejected by mock ' + failure);
    if (args[0] === 'hash-password') return hashOutput;
    if (args[0] === 'validate') {
      assert.deepEqual(args, ['validate', '--config', config.main, '--adapter', 'caddyfile']);
      if (files.has(config.file)) assert.ok(entry(config.file).text.includes('rev4a.example.com'));
    }
    return '';
  };
  let dockerReads = 0;
  const dockerFetch = async (method, url) => {
    assert.equal(method, 'GET');
    dockerReads++;
    if (url.startsWith('/containers/json?')) {
      assert.equal(new URL(url, 'http://localhost').searchParams.get('all'), 'true');
      assert.deepEqual(JSON.parse(new URL(url, 'http://localhost').searchParams.get('filters')), { label: ['AGENT_ID'] });
      return list === undefined ? agents.map((_, Id) => ({ Id })) : list;
    }
    const agent = agents[Number(url.split('/')[2])];
    return inspectAgent(agent);
  };
  const queues = new Map();
  const withLock = (file, callback, fs = io) => {
    assert.equal(fs, io);
    const directory = dirname(file);
    const job = (queues.get(directory) ?? Promise.resolve()).then(callback);
    queues.set(directory, job.catch(() => {}));
    return job;
  };
  const log = { warn: message => messages.push(message), info: message => messages.push(message) };
  const options = { io, run, dockerFetch, withLock, log, dataDir, env };
  return { files, operations, commands, messages, options, dockerReads: () => dockerReads };
}

test('sync writes atomically, validates before reload, stores a 0600 password sent only on stdin, and reuses its hash', async t => {
  const m = mockRuntime();
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: true, routes: 5 });
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'hash-password', 'validate', 'reload']);
  const auth = m.files.get(authFile);
  const secret = JSON.parse(auth.text);
  assert.equal(auth.mode, 0o600);
  assert.equal(secret.user, 'rev4a');
  assert.equal(secret.password.length, 32);
  assert.equal(secret.hash, hash);
  const command = m.commands.find(command => command.args[0] === 'hash-password');
  assert.deepEqual(command.args, ['hash-password', '--algorithm', 'bcrypt']);
  assert.equal(command.input, secret.password);
  assert.ok(!m.commands.some(command => JSON.stringify(command.args).includes(secret.password)));
  assert.ok(!JSON.stringify(m.messages).includes(secret.password));
  assert.equal(m.files.get(config.file).text, golden(3));
  assert.equal(m.files.get(config.file).mode, 0o644);
  assert.ok(m.operations.some(op => op[0] === 'rename' && op[2] === config.file));
  assert.ok(![...m.files.keys()].some(file => file.endsWith('.tmp')));

  m.commands.length = 0;
  m.operations.length = 0;
  m.messages.length = 0;
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: false, routes: 5 });
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version']);
  assert.deepEqual(m.operations, []);
  assert.deepEqual(m.messages, []);

  m.files.get(config.file).text = PENDING + golden(3);
  assert.equal((await syncCaddy(m.options)).changed, true);
  assert.equal(m.files.get(config.file).text, golden(3));
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'version', 'validate', 'reload']);
  t.diagnostic('Password: 32 characters; mode: 0600; stdin matches; argv, generated file and logs omit the password; unchanged writes: 0');
});

test('credential repair rotates malformed, null, loose-mode and out-of-range stored credentials safely', async t => {
  const marker = 'MALFORMED_FIXTURE_PASSWORD';
  const valid = { user: 'rev4a', password: 'a'.repeat(32), hash };
  const badHash = '$2b$99$' + 'a'.repeat(53);
  const fixtures = [
    { text: marker, mode: 0o600 },
    { text: 'null', mode: 0o600 },
    { text: JSON.stringify(valid), mode: 0o644 },
    { text: JSON.stringify({ ...valid, hash: badHash }), mode: 0o600 },
  ];
  for (const fixture of fixtures) {
    const m = mockRuntime({ initial: { [authFile]: fixture } });
    const result = await syncCaddy(m.options);
    assert.equal(result.ok, true);
    assert.equal(m.files.get(authFile).mode, 0o600);
    const repaired = JSON.parse(m.files.get(authFile).text);
    assert.notEqual(repaired.password, valid.password);
    assert.equal(repaired.hash, hash);
    assert.equal(m.commands.find(command => command.args[0] === 'hash-password').input, repaired.password);
    assert.equal(m.messages.filter(line => line.includes('Regenerated the invalid domain credential')).length, 1);
    assert.ok(!JSON.stringify({ result, logs: m.messages }).includes(marker));
  }
  const costs = [9, 10, 14, 15, 99].map(cost => domain.BCRYPT.test(`$2y$${String(cost).padStart(2, '0')}$` + 'a'.repeat(53)));
  assert.deepEqual(costs, [false, true, true, false, false]);
  const invalidCaddy = mockRuntime({ hashOutput: badHash, initial: { [config.file]: golden(1) } });
  assert.match((await syncCaddy(invalidCaddy.options)).error, /invalid bcrypt hash/);
  assert.equal(invalidCaddy.files.get(config.file).text, golden(1));
  assert.equal(invalidCaddy.files.has(authFile), false);
  t.diagnostic(`Malformed, null, 0644 and stored cost 99: regenerated at 0600; marker disclosed: false; bcrypt costs 09/10/14/15/99: ${costs}`);
});

test('failed Caddy validation restores the previous file and never reloads', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(1) }, failure: 'validate' });
  const result = await syncCaddy(m.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected by mock validate/);
  assert.equal(m.files.get(config.file).text, golden(1));
  assert.ok(!m.commands.some(command => command.args[0] === 'reload'));
  assert.ok(m.messages.some(message => message.includes('rejected by mock validate')));
  const empty = mockRuntime({ agents: [], failure: 'validate' });
  assert.equal((await syncCaddy(empty.options)).ok, false);
  // A first failed sync leaves an empty managed file (a valid import target), never a missing one.
  assert.equal(empty.files.get(config.file)?.text, '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup\n');
});

test('a rejected reload never stores a new dev-port credential (dr: rotation ahead of the running config)', async () => {
  const m = mockRuntime({ failure: 'reload' });
  assert.equal((await syncCaddy(m.options)).ok, false);
  assert.equal(m.files.has(authFile), false, 'credential saved only after Caddy accepted the config');
  const ok = mockRuntime();
  assert.equal((await syncCaddy(ok.options)).ok, true);
  assert.equal(ok.files.get(authFile)?.mode, 0o600);
});

test('missing Caddy, disabled mode, and unmanaged files perform no writes', async () => {
  const missing = mockRuntime({ missing: true });
  assert.equal((await syncCaddy(missing.options)).ok, false);
  assert.match(missing.messages[0], /Caddy is missing/);
  assert.deepEqual(missing.operations, []);
  assert.equal(missing.dockerReads(), 0);
  const off = mockRuntime();
  assert.deepEqual(await syncCaddy({ ...off.options, env: { REV4A_DOMAIN: '  ' } }), { ok: true, changed: false });
  assert.deepEqual(off.operations, []);
  assert.deepEqual(off.commands, []);
  assert.equal(off.dockerReads(), 0);
  const staleDaemon = mockRuntime({ initial: { [envFile]: 'REV4A_DOMAIN=new.example.com\n' } });
  assert.deepEqual(await syncCaddy(staleDaemon.options), { ok: true, changed: false });
  assert.deepEqual(staleDaemon.operations, []);
  assert.equal(staleDaemon.dockerReads(), 0);
  const unmanaged = mockRuntime({ initial: { [config.file]: 'operator notes' } });
  assert.match((await syncCaddy(unmanaged.options)).error, /unmanaged file/);
  assert.deepEqual(unmanaged.operations, []);
});

test('unexpected Docker list shapes preserve the generated file', async t => {
  for (const list of [{}, { length: 0 }, null, '']) {
    const m = mockRuntime({ initial: { [config.file]: golden(1) }, list });
    const result = await syncCaddy(m.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /expected an array/);
    assert.equal(m.files.get(config.file).text, golden(1));
    assert.deepEqual(m.operations, []);
  }
  t.diagnostic('Docker object, array-like object, null and string: expected an array; writes: 0');
});

test('sync checks actual import coverage after validation, including on unchanged files', async t => {
  const m = mockRuntime({ agents: [], initial: { [config.file]: golden(1), [config.main]: '# ' + mainImport } });
  const result = await syncCaddy(m.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /is not imported.*rev4a domain setup/);
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'validate']);
  assert.equal(m.files.get(config.file).text, golden(1));
  m.files.get(config.file).text = golden(0);
  assert.equal((await syncCaddy(m.options)).ok, false);
  for (const target of ['*.caddy', '"/etc/caddy/rev4?.caddy"', 'rev4[ab].caddy', mainImport.trim().slice(7)]) {
    m.files.get(config.main).text = 'import ' + target + '\n';
    assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: false, routes: 0 });
    const plan = planCaddyfile(m.files.get(config.main).text, config);
    assert.equal(plan.content.match(/^import /gm).length, 1);
  }
  t.diagnostic('Missing import: ok=false, validated, reloads=0, previous file restored; matching explicit and glob imports: ok=true, one import in setup plan');
});

function loadRoute(file, globals, dependencies) {
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, ...globals, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}

test('the public ask route needs no session and accepts only routed names from a direct loopback callback', async t => {
  const source = readFileSync('app/api/domain/ask/route.ts', 'utf8');
  assert.match(source, /new Response\(null/);
  let content = golden(3);
  let currentFleet = fleet;
  const runtimeEnv = { ...env };
  const route = loadRoute('app/api/domain/ask/route.ts', { Response, process: { env: runtimeEnv } }, {
    '@/lib/domain': domain,
    '@/lib/caddy': { checkAgentRoute: route => checkAgentRoute(route, async (_method, url) => {
      const container = currentFleet.find(agent => url === '/containers/' + agent.containerName + '/json');
      if (!container) throw new Error('Missing container');
      return inspectAgent(container);
    }) },
    'node:fs/promises': { readFile: async () => content },
  });
  const trusted = parseTrustedProxies('127.0.0.1,::1,192.0.2.10');
  const request = async (name, ip = '127.0.0.1', { host = '127.0.0.1:3740', xff, duplicate = false } = {}) => {
    const url = `http://127.0.0.1:3740${ASK_PATH}?domain=${encodeURIComponent(name)}${duplicate ? '&domain=duplicate' : ''}`;
    const headers = { host, [SOCKET_PEER_HEADER]: '127.0.0.1', [CLIENT_IP_HEADER]: '127.0.0.1' };
    if (xff) headers['x-forwarded-for'] = xff;
    setClientAddressHeaders(headers, ip, trusted);
    if (ip === '192.0.2.10' && xff) {
      assert.equal(headers[CLIENT_IP_HEADER], '127.0.0.1');
      assert.equal(headers[SOCKET_PEER_HEADER], '192.0.2.10');
    }
    const response = await route.GET(new Request(url, { headers }));
    assert.equal(await response.text(), '');
    return response.status;
  };
  for (const name of [config.domain, 'ATLAS.REV4A.EXAMPLE.COM', 'atlas-3001.rev4a.example.com', 'beacon-3009.rev4a.example.com']) {
    assert.equal(await request(name), 200, name);
  }
  for (const denied of ['beacon-3001.rev4a.example.com', 'gone.rev4a.example.com', 'deeper.atlas.rev4a.example.com', '*.rev4a.example.com', 'rev4a.example.net', '']) {
    assert.equal(await request(denied), 404, denied);
  }
  assert.equal(await request(config.domain, '192.0.2.10'), 404);
  const trustedRemote = await request(config.domain, '192.0.2.10', { xff: '127.0.0.1' });
  assert.equal(trustedRemote, 404);
  assert.equal(await request(config.domain, '10.0.0.2', { xff: '127.0.0.1' }), 404);
  assert.equal(await request(config.domain, '127.0.0.1', { xff: '127.0.0.1, 192.0.2.10' }), 404);
  assert.equal(await request(config.domain, '127.0.0.1', { host: config.domain }), 404);
  assert.equal(await request(config.domain, '127.0.0.1', { duplicate: true }), 404);
  const old = { ...fleet[0], containerName: 'old', displayName: 'Old', activeBindings: bindings('9000', '') };
  const newOwner = { ...fleet[1], activeBindings: bindings('9000', '') };
  content = renderCaddyfile(config, buildNameTable([old]), hash);
  currentFleet = [{ ...old, running: false, bindings: bindings('9000', ''), activeBindings: null }, newOwner];
  const staleStatus = await request('old.rev4a.example.com');
  assert.equal(staleStatus, 404);
  content = renderCaddyfile(config, buildNameTable(currentFleet), hash);
  assert.ok(!content.includes('@old host') && content.includes('@beacon host'));
  assert.equal(await request('old.rev4a.example.com'), 404);
  currentFleet = [old];
  content = renderCaddyfile(config, buildNameTable(currentFleet), hash);
  const startedStatus = await request('old.rev4a.example.com');
  assert.equal(startedStatus, 200);
  assert.match(content, /@old host.*\n\s*handle @old \{\n\s*reverse_proxy 127\.0\.0\.1:9000/);
  t.diagnostic(`Trusted remote peer forwarding loopback: ${trustedRemote}; stale stopped route: ${staleStatus}; started route: ${startedStatus}`);
  content = golden(3);
  currentFleet = fleet.slice(1);
  assert.equal(await request('atlas.rev4a.example.com'), 404);
  currentFleet = [{ ...fleet[0], activeBindings: bindings('3700', '3901') }, ...fleet.slice(1)];
  assert.equal(await request('atlas-3001.rev4a.example.com'), 404);
  assert.equal(await request('atlas.rev4a.example.com'), 200);
  content = PENDING + golden(3);
  assert.equal(await request('atlas.rev4a.example.com'), 404);
  runtimeEnv.REV4A_SUPERVISED = '';
  assert.equal(await request(config.domain), 404);
  assert.ok(!Object.hasOwn(sessionCookieOptions(new Request('https://' + config.domain), { maxAge: 100 }), 'domain'));
});

const previous = '# Operator comment\nrev4a.example.com { reverse_proxy 127.0.0.1:3740 }\n';
const ask = 'ask http://127.0.0.1:3740/api/domain/ask';
test('setup planner creates a fresh config, adopts the existing site, and merges global options without churn', () => {
  const fresh = planCaddyfile('', config);
  assert.match(fresh.content, /^\{\n\ton_demand_tls \{/);
  assert.ok(fresh.content.includes(ask));
  assert.ok(fresh.content.endsWith('import /etc/caddy/rev4a.caddy\n'));
  const adopted = planCaddyfile(previous, config);
  assert.ok(adopted.content.includes('# Operator comment\n# Rev4a adopted'));
  assert.ok(adopted.content.includes('# rev4a.example.com { reverse_proxy 127.0.0.1:3740 }'));
  const deployedHost = 'rev4a.example.com';
  const deployed = deployedHost + ' { reverse_proxy 127.0.0.1:3740 }\n# Existing comment\n';
  assert.ok(planCaddyfile(deployed, { ...config, domain: deployedHost }).content.includes('# ' + deployed));
  const existing = '{\n\tdebug # comment\n\tlog {\n\t\toutput stderr\n\t}\n}\n' +
    'test.example.com {\n\trespond "{preserve this}"\n}\n';
  const merged = planCaddyfile(existing, config);
  assert.ok(merged.content.startsWith('{\n\ton_demand_tls'));
  assert.equal(merged.content.split('\n').filter(line => line === '{').length, 1);
  assert.ok(merged.content.includes('respond "{preserve this}"'));
  const heredoc = 'other.example.com {\n\trespond <<BODY\nA brace } and " are message text\nBODY\n}\n';
  assert.ok(planCaddyfile(heredoc, config).content.includes(heredoc));
  const preexistingOptions = '{\n\ton_demand_tls {\n\t}\n}\nimport "rev4a.caddy"\n';
  assert.ok(planCaddyfile(preexistingOptions, config).content.includes(ask));
  for (const plan of [fresh, adopted, merged, planCaddyfile(preexistingOptions, config)]) {
    assert.deepEqual(planCaddyfile(plan.content, config), { content: plan.content, actions: [] });
  }
  assert.throws(() => planCaddyfile('{\n\ton_demand_tls {\n\t\task http://somewhere.test/ask\n\t}\n}\n', config), /different global/);
  assert.throws(() => planCaddyfile('rev4a.example.com, other.example.com {\n}\n', config), /shares a Caddy site/);
});
const args = ['setup', config.domain];
const root = { uid: 0, platform: 'linux', now: () => new Date('2026-11-18T00:00:00.000Z') };
test('root setup backs up the original, edits .env through its shared editor, and runs idempotently', async () => {
  const originalEnv = '# settings\nEXAMPLE=value\nREV4A_TRUSTED_PROXIES=192.0.2.1,127.0.0.1\n';
  const m = mockRuntime({ initial: { [config.main]: previous, [envFile]: { text: originalEnv, mode: 0o600 } } });
  assert.deepEqual(await setupDomain({ ...m.options, ...root, args }), { changed: true });
  const backup = [...m.files.keys()].find(file => file.includes('.bak-'));
  assert.equal(m.files.get(backup).text, previous);
  assert.equal(m.files.get(config.main).text, planCaddyfile(previous, config).content);
  assert.match(m.files.get(envFile).text, /REV4A_TRUSTED_PROXIES=192\.0\.2\.1,127\.0\.0\.1,::1/);
  assert.match(m.files.get(envFile).text, /^# settings\nEXAMPLE=value\n/);
  assert.match(m.files.get(envFile).text, /REV4A_DOMAIN=rev4a\.example\.com\nREV4A_LISTEN=local\nREV4A_AGENT_PORTS_LISTEN=local/);
  assert.equal(m.files.get(envFile).mode, 0o600);
  assert.ok(m.messages.some(message => message.includes('Restart Rev4a and Recreate')));
  m.operations.length = 0;
  m.commands.length = 0;
  assert.deepEqual(await setupDomain({ ...m.options, ...root, args }), { changed: false });
  assert.deepEqual(m.operations, []);
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version']);
});

test('failed setup preserves the original main and environment and keeps the backup', async () => {
  for (const failure of ['validate', 'reload']) {
    const m = mockRuntime({ initial: { [config.main]: previous, [envFile]: { text: 'EXAMPLE=value\n', mode: 0o600 } }, failure });
    await assert.rejects(setupDomain({ ...m.options, ...root, args }), new RegExp(failure));
    assert.equal(m.files.get(config.main).text, previous);
    assert.equal(m.files.get(envFile).text, 'EXAMPLE=value\n');
    assert.equal(m.files.get(config.file)?.text, '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup\n');
    assert.ok([...m.files.keys()].some(file => file.includes('.bak-')));
  }
});

test('failed setup preserves a concurrent Config save and operator Caddyfile edit', async t => {
  const original = 'EXAMPLE=value\nREV4A_LISTEN=all\nREV4A_AGENT_PORTS_LISTEN=\n';
  const m = mockRuntime({ initial: { [config.main]: previous, [envFile]: { text: original, mode: 0o600 } }, failure: 'reload' });
  const editor = loadRoute('lib/env-edit.ts', { console, process: { env: {}, platform: 'linux' } }, {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    'fs': {
      readFileSync: file => m.files.get(file).text,
      writeFileSync: (file, text) => { m.files.get(file).text = text; },
      chmodSync: () => {},
    },
    'child_process': { execSync: () => {} },
    '@/lib/rev4a-paths': { ENV_FILE: envFile },
    '@/lib/env-file': envEditor,
    '@/lib/file-lock': { withFileDirectoryLock: m.options.withLock },
    '@/lib/listen-addresses': require('../lib/listen-addresses.js'),
  });
  const run = async (program, argv, options) => {
    if (program === 'caddy' && argv[0] === 'reload') {
      const response = await editor.saveEnvironment({ env: { REV4A_LISTEN: '127.0.0.1', REV4A_OPERATOR_SETTING: '1' } });
      assert.equal(response.status, 200);
      m.files.get(envFile).text += 'NEW_OPERATOR_SETTING=1\n';
      m.files.get(config.main).text += '# operator change during reload\n';
    }
    return m.options.run(program, argv, options);
  };
  await assert.rejects(setupDomain({ ...m.options, ...root, args, run }), /rejected by mock reload/);
  assert.equal(m.files.get(envFile).text, original.replace('LISTEN=all', 'LISTEN=127.0.0.1')
    + 'REV4A_OPERATOR_SETTING=1\nNEW_OPERATOR_SETTING=1\n');
  assert.equal(m.files.get(config.main).text, planCaddyfile(previous, config).content + '# operator change during reload\n');
  assert.equal(m.files.get(config.file)?.text, '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup\n');
  assert.ok(m.messages.some(message => message.includes('The main Caddyfile changed during setup')));
  t.diagnostic('Config save: 200; NEW_OPERATOR_SETTING=1 survived; later REV4A_LISTEN=127.0.0.1 survived; other setup keys rolled back; main Caddyfile edit kept');
});

test('the running process waits for restart after same-domain setup moves the dashboard port', async t => {
  const m = mockRuntime({ agents: [], initial: {
    [config.main]: planCaddyfile('', config).content, [config.file]: golden(0),
  } });
  const afterSetup = { ...env, PORT: '8080' };
  assert.deepEqual(await setupDomain({ ...m.options, ...root, args, env: afterSetup }), { changed: true });
  assert.match(m.files.get(config.main).text, /ask http:\/\/127\.0\.0\.1:8080\/api\/domain\/ask/);
  assert.match(m.files.get(config.file).text, /reverse_proxy 127\.0\.0\.1:8080/);
  m.operations.length = 0;
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: false });
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: false });
  assert.deepEqual(m.operations, []);
  assert.equal(m.messages.filter(message => message.includes('Sync is paused until restart')).length, 1);
  assert.deepEqual(await syncCaddy({ ...m.options, env: afterSetup }), { ok: true, changed: false, routes: 0 });
  t.diagnostic('Same-domain setup: ask and upstream on 8080; old runtime on 3740: writes=0, restart messages=1; restarted runtime: routes=0, unchanged');
});

test('lifecycle start, stop and both restart routes request a sync after the Docker operation', async () => {
  const effects = [];
  const statuses = { start: 'exited', stop: 'running', restart: 'running' };
  let action;
  const modules = {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    'child_process': { execSync: command => { effects.push(command); return 'running\n'; } },
    '@/lib/container': { resolveAgentedContainer: () => 'fixture', isValidAgentId: () => true, isLifecycleCoolingDown: () => false, markLifecycleCooldown: () => {} },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    '@/lib/credentials/delivery': { reapplyWhenReady: async () => {} },
    '@/lib/docker-socket': { dockerFetch: async () => ({ State: { Status: statuses[action] } }) },
    '@/lib/agent-ports-server': { currentAgentPortsListen: () => ({ hostIp: '127.0.0.1' }) },
    '@/lib/agent-ports': { agentPortContainerState: state => state.Status === 'exited' ? 'stopped' : 'running', publishesDifferently: () => false },
    '@/lib/agent-recreate': {},
    '@/lib/agent-operation': { runAgentOperation: async (_id, operation) => operation() },
    '@/lib/domain-sync': { syncDomainRoutes: async () => effects.push('sync') },
  };
  for (const [endpoint, operation] of [['lifecycle', 'start'], ['lifecycle', 'stop'], ['lifecycle', 'restart'], ['restart', 'restart']]) {
    effects.length = 0;
    action = operation;
    const route = loadRoute(`app/api/agents/[id]/${endpoint}/route.ts`, { console, process: { env } }, modules);
    const result = await route.POST(new Request('http://localhost/', { method: 'POST', body: JSON.stringify({ action }) }), {
      params: Promise.resolve({ id: 'fixture' }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.status, 200);
    assert.match(effects[0], new RegExp(`^docker ${operation} `));
    assert.equal(effects.at(-1), 'sync');
  }
});

test('non-root and non-Linux are refused and dry-run does no writes or commands', async () => {
  const m = mockRuntime({ initial: { [config.main]: previous } });
  await assert.rejects(setupDomain({ ...m.options, ...root, args, uid: 1000 }), /requires root/);
  await assert.rejects(setupDomain({ ...m.options, ...root, args, platform: 'darwin' }), /requires Linux/);
  await setupDomain({ ...m.options, ...root, args: [...args, '--dry-run'] });
  assert.deepEqual(m.commands, []);
  assert.deepEqual(m.operations, []);
  assert.equal(m.dockerReads(), 0);
  assert.equal(m.files.get(config.main).text, previous);
  assert.ok(m.messages.some(message => message.includes('Comment out and preserve')));
});

test('missing Caddy uses the official apt repository and adopts the packaged main file', async () => {
  const m = mockRuntime({ missing: true, agents: [] });
  assert.deepEqual(await setupDomain({ ...m.options, ...root, args }), { changed: true });
  assert.ok(m.commands.some(command => command.program === 'curl' && command.args.includes('https://dl.cloudsmith.io/public/caddy/stable/gpg.key')));
  assert.ok(m.commands.some(command => command.program === 'apt-get' && command.args.join(' ') === 'install -y caddy'));
  assert.ok(m.files.has('/usr/share/keyrings/caddy-stable-archive-keyring.gpg'));
  assert.ok(m.files.has('/etc/apt/sources.list.d/caddy-stable.list'));
  assert.match(m.files.get(config.main).text, /respond "Package default"/);
  assert.equal(m.files.get(config.file).text, golden(0));
});
