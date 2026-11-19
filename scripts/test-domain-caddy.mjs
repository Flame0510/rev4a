import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const domain = require('../lib/domain.js');
const { ASK_PATH, RELOAD_UNCONFIRMED, agentBase, agentHostPort, buildNameTable, domainConfig, normalizeDomain, readAssignments, readManagedRoutes, renderCaddyfile } = domain;
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
  { containerName: 'atlas', agentId: 'atlas', displayName: 'Atlas', created: '2026-10-01T00:00:00Z', running: true, activeBindings: bindings('3700', '3701') },
  { containerName: 'beacon', agentId: 'beacon', displayName: 'Beacon', created: '2026-10-02T00:00:00Z', running: true, activeBindings: { ...bindings('3710', '', '0.0.0.0'), '3009/tcp': [binding('3719', '0.0.0.0')] } },
  { containerName: 'relay', agentId: 'relay', displayName: 'Relay', created: '2026-10-03T00:00:00Z', running: true, activeBindings: bindings('3720', '') },
];
const goldenManifest = (label, name) => [
  `\t\t@${label}_manifest path /manifest.webmanifest`,
  `\t\theader @${label}_manifest Content-Type "application/manifest+json"`,
  `\t\theader @${label}_manifest Cache-Control "no-cache"`,
  `\t\trespond @${label}_manifest \`{"name":"${name}","short_name":"${name}","id":"/?rev4a-agent=${label}",`
    + `"start_url":"./","scope":"./","display":"standalone","theme_color":"#0a0a0a","background_color":"#0a0a0a",`
    + `"description":"${name} · OpenClaw agent (Rev4a)","icons":[{"src":"./favicon.svg","sizes":"any","type":"image/svg+xml"},`
    + `{"src":"./favicon-32.png","sizes":"32x32","type":"image/png"},{"src":"./apple-touch-icon.png","sizes":"180x180","type":"image/png"}]}\` 200`,
];
const golden = n => [
  '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup',
  '# Rev4a domain: rev4a.example.com',
  ...(n ? ['# Rev4a agent: atlas atlas atlas', '# Rev4a agent id: atlas atlas'] : []),
  ...(n === 3 ? ['# Rev4a agent: beacon beacon beacon', '# Rev4a agent id: beacon beacon', '# Rev4a agent: relay relay relay', '# Rev4a agent id: relay relay'] : []),
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
    ...goldenManifest('atlas', 'Atlas'),
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
    ...goldenManifest('beacon', 'Beacon'),
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
    ...goldenManifest('relay', 'Relay'),
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
const legacyCaddyfile = n => golden(n).replace(/^(?:\t\t.*_manifest .*|# Rev4a agent id: .*)\n/gm, '');

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
    ['six', 'server-3009', 'server-3009-agent'],
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
  const competing = buildNameTable([second, third, { ...fleet[0], containerName: 'newcomer', agentId: 'newcomer', displayName: 'Same' }], gap.assignments);
  assert.equal(competing.assignments.get('newcomer').name, 'same-4');
  const remembered = readAssignments(renderCaddyfile(config, gap, hash), config.domain);
  const recreated = buildNameTable([second, third, { ...first, created: '2026-10-04' }], remembered);
  assert.deepEqual(recreated, initial);
  const renamed = buildNameTable([{ ...first, displayName: 'New name' }, second, third], recreated.assignments);
  assert.equal(renamed.assignments.get(first.containerName).name, 'new-name');
  assert.equal(renamed.assignments.get(second.containerName).name, 'same-2');
});

test('Control UI never claims a dev-port label, even when the dev-port owner arrives later', () => {
  const colliding = { ...fleet[1], displayName: 'Atlas-3001', created: '2026-09-01' };
  const old = new Map([[colliding.containerName, { base: 'atlas-3001', name: 'atlas-3001' }]]);
  const previous = buildNameTable([colliding], old);
  assert.equal(previous.assignments.get(colliding.containerName).name, 'atlas-3001-agent');
  const table = buildNameTable([colliding, fleet[0]], old);
  assert.equal(table.routes.find(route => route.name === 'atlas-3001').dev, true);
  assert.equal(table.routes.find(route => route.name === 'atlas-3001-agent').dev, false);
});

test('golden generated Caddyfiles for 0, 1, and 3 agents', () => {
  for (const n of [0, 1, 3]) {
    assert.equal(renderCaddyfile(config, buildNameTable(fleet.slice(0, n)), hash), golden(n));
  }
});

test('manifest values round-trip through JSON without raw Caddy delimiters or placeholders', () => {
  const fixtures = [
    ['{`}"\n\\\u0000{$REV4A_DOMAIN} {http.request.host}\n\t\treverse_proxy 127.0.0.1:9999 {', '{`}"\n\\\u0000{$REV'],
    ['Unicode\u2028# Rev4a agent: phantom phantom phantom\u2029', 'Unicode\u2028# Re'],
    ['🚀'.repeat(11) + '🧪🌍', '🚀'.repeat(11) + '🧪'],
    ['X'.repeat(100_000) + '{tail}`', 'XXXXXXXXXXXX'],
    ['', 'atlas'],
  ];
  for (const [displayName, shortName] of fixtures) {
    const agent = { ...fleet[0], displayName };
    const table = buildNameTable([agent]);
    const label = table.assignments.get(agent.containerName).name;
    const content = renderCaddyfile(config, table, hash);
    const body = content.split('\n')
      .find(line => line.startsWith(`\t\trespond @${label}_manifest `))?.match(/`([^`]*)` 200$/)?.[1];
    assert.ok(body, 'manifest body must fit inside one backtick argument');
    const manifest = JSON.parse(body);
    for (const token of body.match(/"[^"\\]*(?:\\.[^"\\]*)*"/g)) assert.doesNotMatch(token, /[{}\x60\u2028\u2029]/);
    assert.equal(manifest.name, displayName || label);
    assert.equal(manifest.short_name, shortName);
    assert.equal(manifest.description, `${displayName || label} · OpenClaw agent (Rev4a)`);
    assert.equal(manifest.id, `/?rev4a-agent=${label}`);
    assert.deepEqual(readAssignments(content, config.domain), table.assignments);
    assert.deepEqual([...readManagedRoutes(content, config.domain)], [[label, 3700], [`${label}-3001`, 3701]]);
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
    Config: { Labels: { AGENT_ID: agent.agentId ?? agent.containerName }, Env: ['OTHER=fake', 'AGENT_NAME=' + (agent.displayName ?? '')] },
    Created: agent.created,
    State: { Running: agent.running, Paused: agent.paused, Restarting: agent.restarting },
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
  const withLock = (file, callback, options = {}) => {
    assert.equal(options.io ?? io, io);
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

  // An interrupted sync from an earlier build may have left the old marker format.
  m.files.get(config.file).text = '# Rev4a reload pending\n' + golden(3) + '# Rev4a pending port: 4600\n';
  assert.equal((await syncCaddy(m.options)).changed, true);
  assert.equal(m.files.get(config.file).text, golden(3));
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'version', 'validate', 'reload']);
  t.diagnostic('Password: 32 characters; mode: 0600; stdin matches; argv, generated file and logs omit the password; unchanged writes: 0');
});

test('sync upgrades a pre-manifest import once and preserves routes and the existing credential', async () => {
  const m = mockRuntime({ initial: {
    [config.file]: legacyCaddyfile(3),
    [authFile]: { text: JSON.stringify({ user: 'rev4a', password: 'a'.repeat(32), hash }), mode: 0o600 },
  } });
  const previousRoutes = readManagedRoutes(m.files.get(config.file).text, config.domain);
  assert.equal(previousRoutes.size, 5);
  const credential = m.files.get(authFile);
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: true, routes: 5 });
  assert.equal(m.files.get(config.file).text, golden(3));
  assert.deepEqual(readManagedRoutes(m.files.get(config.file).text, config.domain), previousRoutes);
  assert.equal(m.files.get(authFile), credential);
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: false, routes: 5 });
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'validate', 'reload', 'version']);
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

test('a dev-port credential write failure restores the managed file before any reload', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(1) } });
  const rename = m.options.io.rename;
  m.options.io.rename = async (source, destination) => {
    if (destination === authFile) throw new Error('Mock credential write failed');
    await rename(source, destination);
  };
  assert.match((await syncCaddy(m.options)).error, /Mock credential write failed/);
  assert.deepEqual(m.commands.map(command => command.args[0]), ['version', 'hash-password', 'validate']);
  assert.equal(m.files.has(authFile), false);
  assert.equal(m.files.get(config.file).text, golden(1));
});

test('reload sees the saved credential, and a retry reuses it after reload fails', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(1) } });
  let rejectReload = true;
  const run = m.options.run;
  m.options.run = async (command, args, opts) => {
    const result = await run(command, args, opts);
    if (args[0] === 'reload') {
      assert.equal(m.files.get(authFile)?.mode, 0o600);
      if (rejectReload) throw new Error('Mock reload failed');
    }
    return result;
  };
  assert.match((await syncCaddy(m.options)).error, /Mock reload failed/);
  assert.equal(m.files.get(config.file).text, golden(3) + RELOAD_UNCONFIRMED);
  const saved = m.files.get(authFile).text;
  rejectReload = false;
  assert.equal((await syncCaddy(m.options)).ok, true);
  assert.equal(m.files.get(authFile).text, saved);
  assert.equal(m.commands.filter(command => command.args[0] === 'hash-password').length, 1);
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
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, ...globals, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}

const ports = loadRoute('lib/agent-ports.ts', {}, {});
function loadAllocator(m, { settings = env, io = m.options.io, dockerFetch = async () => [],
  withLock = m.options.withLock } = {}) {
  return loadRoute('lib/agent-ports-server.ts', { process: { env: settings } }, {
    fs: { promises: io, readFileSync: file => m.files.get(file)?.text ?? '' },
    os: {},
    '@/lib/docker-socket': { dockerFetch },
    '@/lib/rev4a-paths': { ENV_FILE: envFile },
    '@/lib/env-file': envEditor,
    './agent-ports': ports,
    './domain.js': domain,
    './file-lock': { withFileDirectoryLock: withLock },
    './listen-addresses': require('../lib/listen-addresses.js'),
  });
}

test('double reload failure keeps the candidate and retries it even when the next render matches', async () => {
  const agents = [{ ...fleet[0], activeBindings: bindings('3900', '3901') }];
  const m = mockRuntime({ initial: { [config.file]: golden(1).trimEnd() }, agents });
  const allocator = loadAllocator(m);
  const held = async (opts) => [...await allocator.getUsedHostPorts(opts)].sort((a, b) => a - b);
  let reloads = 0;
  let active;
  const run = async (command, args, opts) => {
    const result = await m.options.run(command, args, opts);
    if (args[0] !== 'reload') return result;
    if (++reloads === 2) throw new Error('Rollback reload failed');
    const text = m.files.get(config.file).text;
    assert.ok(text.endsWith('\n' + RELOAD_UNCONFIRMED));
    active = domain.readRouteReservations(text).routes;
    if (reloads === 1) throw new Error('Candidate reload timed out after applying');
    return result;
  };
  assert.match((await syncCaddy({ ...m.options, run })).error, /Candidate reload timed out/);
  assert.equal(reloads, 2);
  assert.equal(active.get('atlas'), 3900);
  const candidate = golden(1).replaceAll('127.0.0.1:3700', '127.0.0.1:3900').replaceAll('127.0.0.1:3701', '127.0.0.1:3901');
  assert.equal(m.files.get(config.file).text, candidate + RELOAD_UNCONFIRMED);
  assert.ok(m.messages.some(message => message.includes('CADDY ROLLBACK UNCONFIRMED')));
  assert.deepEqual(await held(), [3740, 3900, 3901]);
  assert.deepEqual(await syncCaddy({ ...m.options, run }), { ok: true, changed: true, routes: 2 });
  assert.equal(reloads, 3);
  assert.equal(active.get('atlas'), 3900);
  assert.equal(m.files.get(config.file).text, candidate);
  assert.deepEqual(await held(), [3740, 3900, 3901]);
  assert.equal((await syncCaddy(m.options)).changed, false);
});

test('a confirmed rollback clears an earlier unconfirmed marker and restores published routes', async () => {
  const agents = [{ ...fleet[0], activeBindings: bindings('3900', '3901') }];
  const m = mockRuntime({ initial: { [config.file]: golden(1) + RELOAD_UNCONFIRMED }, agents });
  let reloads = 0;
  const run = async (command, args, opts) => {
    if (args[0] !== 'reload') return m.options.run(command, args, opts);
    const { routes } = domain.readRouteReservations(m.files.get(config.file).text);
    if (++reloads === 1) {
      assert.equal(routes.get('atlas'), 3900);
      throw new Error('Candidate reload failed');
    }
    assert.equal(routes.get('atlas'), 3700);
    return '';
  };
  assert.match((await syncCaddy({ ...m.options, run })).error, /Candidate reload failed/);
  assert.equal(reloads, 2);
  assert.equal(m.files.get(config.file).text, golden(1));
  assert.equal(readManagedRoutes(m.files.get(config.file).text, config.domain).get('atlas'), 3700);
  assert.deepEqual([...await loadAllocator(m).getUsedHostPorts()].sort((a, b) => a - b), [3700, 3701, 3740]);
});

test('allocator refuses unreadable files and lock failures; missing files and Domain off are allowed', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(1) } });
  const settings = { ...env };
  let readError;
  let regular = true;
  let lockError;
  let lockCalls = 0;
  const io = {
    lstat: async file => ({ ...await m.options.io.lstat(file), isFile: () => regular }),
    readFile: async file => {
      if (readError) throw Object.assign(new Error(readError), { code: readError });
      return m.options.io.readFile(file);
    },
  };
  const withLock = async (file, callback, opts) => {
    assert.equal(file, config.file);
    assert.equal(opts.timeoutSeconds, 10);
    assert.equal(opts.allowMissingFlock, undefined);
    lockCalls++;
    if (lockError) throw new Error('Could not acquire the lock');
    return callback();
  };
  const allocator = loadAllocator(m, { settings, io, withLock });
  for (const code of ['EACCES', 'EIO']) {
    readError = code;
    await assert.rejects(allocator.getUsedHostPorts(), new RegExp(`Cannot read the managed Caddy file.*port allocation is paused.*${code}`));
  }
  readError = undefined;
  regular = false;
  await assert.rejects(allocator.getUsedHostPorts(), /port allocation is paused.*regular file/);
  lockError = true;
  await assert.rejects(allocator.getUsedHostPorts(), /port allocation is paused.*Could not acquire the lock/);
  lockError = false;
  m.files.delete(config.file);
  assert.deepEqual([...await allocator.getUsedHostPorts()], []);
  const before = lockCalls;
  lockError = true;
  delete settings.REV4A_DOMAIN;
  assert.deepEqual([...await allocator.getUsedHostPorts()], []);
  assert.equal(lockCalls, before);
});

test('allocator waits for a sync with a pre-delete snapshot to publish its reservations', async () => {
  const m = mockRuntime({ agents: [fleet[0]] });
  const inspectStarted = Promise.withResolvers();
  const releaseInspect = Promise.withResolvers();
  const lockRequested = Promise.withResolvers();
  let read = false;
  const allocator = loadAllocator(m, {
    io: { ...m.options.io, readFile: async file => { read = true; return m.options.io.readFile(file); } },
    withLock: (...args) => { lockRequested.resolve(); return m.options.withLock(...args); },
  });
  const sync = syncCaddy({ ...m.options, dockerFetch: async (method, path, ...args) => {
    const snapshot = await m.options.dockerFetch(method, path, ...args);
    if (!path.startsWith('/containers/json?')) {
      inspectStarted.resolve();
      await releaseInspect.promise;
    }
    return snapshot;
  } });
  await inspectStarted.promise;
  // The allocator sees an empty Docker inventory after the delete.
  const allocation = allocator.getUsedHostPorts();
  await lockRequested.promise;
  assert.equal(read, false);
  releaseInspect.resolve();
  assert.equal((await sync).ok, true);
  assert.deepEqual([...await allocation].sort((a, b) => a - b), [3700, 3701, 3740]);
  assert.equal(read, true);
});

test('allocator exempts a routed host port only for its existing TCP container port', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(1) } });
  const allocator = loadAllocator(m, { dockerFetch: async (_method, path) =>
    path.startsWith('/containers/json?') ? [{ Id: 'atlas' }] : inspectAgent(fleet[0]) });
  const held = async mapping => [...await allocator.getUsedHostPorts({
    excludeContainerId: 'atlas', portArgs: ['-p', mapping],
  })].sort((a, b) => a - b);
  assert.deepEqual(await held('127.0.0.1:3700-3701:3000-3001'), [3740]);
  assert.deepEqual(await held('127.0.0.1:3699-3700:3000-3001'), [3700, 3701, 3740]);
  assert.deepEqual(await held('127.0.0.1:3700:3000/udp'), [3700, 3701, 3740]);
  const edit = loadRoute('lib/agent-edit.ts', {}, {
    '@/lib/container': { isValidAgentId: () => true },
    '@/lib/agent-ports': ports,
    '@/lib/agent-ports-server': { ...allocator, agentPortsHostIp: () => '127.0.0.1' },
    '@/lib/agent-images': {},
    '@/lib/agent-recreate': { inspectAgentContainer: async () => inspectAgent(fleet[0]) },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    '@/lib/agent-readiness': {},
    '@/lib/agent-setup': {},
    '@/app/api/gateway/sync': {},
    '@/lib/agent-edit-state': { isEditActive: () => false, insertEdit: () => assert.fail('Unsafe edit was recorded') },
  });
  await assert.rejects(edit.startAgentEdit('atlas', { portRange: '3699-3700' }), /Ports already in use: 3700/);
});

test('unchanged Recreate and Update can reuse a routed binding through a legacy container rename', async () => {
  const legacy = { ...fleet[0], containerName: 'legacy-atlas', agentId: 'atlas-id', activeBindings: bindings('4600', '') };
  const m = mockRuntime({ agents: [legacy] });
  assert.equal((await syncCaddy(m.options)).ok, true);
  let agent = legacy;
  const allocator = loadAllocator(m, { dockerFetch: async (_method, path) =>
    path.startsWith('/containers/json?') ? [{ Id: agent.containerName }] : inspectAgent(agent) });
  const calls = [];
  const recreate = loadRoute('lib/agent-recreate.ts', {}, {
    '@/lib/docker-socket': {},
    '@/lib/agent-images': { runDocker: async args => calls.push([...args]) },
    '@/lib/agent-ports': ports,
    '@/lib/agent-ports-server': { ...allocator, agentPortsHostIp: () => '127.0.0.1', assertPortArgsHostIps: () => {} },
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/container': {},
    '@/lib/backups-volume': {},
    '@/lib/cold-backup': {},
    '@/lib/agent-readiness': {},
    '@/lib/agent-recreate-state': {},
    '@/lib/agent-busy': {},
    '@/app/api/gateway/sync': {},
    '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
    '@/lib/agent-stop': { removeAgentContainer: async () => calls.push(['rm']) },
  });
  const rebuild = (opts) => {
    const container = inspectAgent(agent);
    container.HostConfig.NetworkMode = 'bridge';
    return recreate.recreateAgentContainer('atlas-id', container, 'image', opts);
  };
  await rebuild({ gracefulStop: true });
  agent = { ...legacy, containerName: 'atlas-id' };
  await rebuild();
  assert.deepEqual(calls.map(args => args[0]), ['rm', 'run', 'rm', 'run']);
  for (const args of calls.filter(row => row[0] === 'run')) {
    assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1:4600:3000');
  }
  assert.match(m.files.get(config.file).text, /# Rev4a agent id: legacy-atlas atlas-id/);
  agent.agentId = 'another-id';
  await assert.rejects(rebuild(), /Port 4600 is already published by managed Caddy routes/);
  assert.equal(calls.length, 4);
});

test('a successful sync releases removed ports and retains a deleted container label', async () => {
  const replacement = { ...fleet[1], displayName: 'Atlas' };
  const m = mockRuntime({ initial: { [config.file]: golden(1) }, agents: [replacement] });
  const allocator = loadAllocator(m);
  assert.equal((await syncCaddy({ ...m.options, forgetContainer: 'atlas' })).ok, true);
  const final = m.files.get(config.file).text;
  assert.match(final, /^# Rev4a retired: atlas$/m);
  assert.match(final, /@atlas-2 host/);
  assert.equal((await syncCaddy(m.options)).changed, false);
  assert.deepEqual([...await allocator.getUsedHostPorts()].sort((a, b) => a - b), [3710, 3719, 3740]);
});

test('a first sync adds IDs to legacy assignments, and a container rename keeps atlas', async () => {
  const legacy = { ...fleet[0], containerName: 'atlas', agentId: 'agent_123', displayName: undefined };
  const agents = [legacy];
  const m = mockRuntime({ agents, initial: { [config.file]: legacyCaddyfile(1) } });
  assert.deepEqual(readAssignments(legacyCaddyfile(1), config.domain).get('atlas'), { base: 'atlas', name: 'atlas' });
  assert.equal((await syncCaddy(m.options)).changed, true);
  assert.match(m.files.get(config.file).text, /^# Rev4a agent id: atlas agent_123$/m);
  agents.length = 0;
  assert.equal((await syncCaddy(m.options)).changed, true);
  agents.push({ ...legacy, id: 'replacement', containerName: 'agent_123' });
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: true, routes: 2 });
  const text = m.files.get(config.file).text;
  assert.deepEqual([...readAssignments(text, config.domain)], [['agent_123', { base: 'agent-123', name: 'atlas', id: 'agent_123' }]]);
  assert.deepEqual([...readManagedRoutes(text, config.domain)], [['atlas', 3700], ['atlas-3001', 3701]]);
  assert.equal((await syncCaddy(m.options)).changed, false);
});

test('reusing the legacy Docker name cannot take the original agent hostname', async () => {
  const original = { ...fleet[0], containerName: 'legacy-atlas', agentId: 'atlas-id', displayName: undefined };
  const agents = [original];
  const m = mockRuntime({ agents });
  assert.equal((await syncCaddy(m.options)).ok, true);
  assert.equal(readManagedRoutes(m.files.get(config.file).text, config.domain).get('legacy-atlas'), 3700);
  agents.splice(0, 1,
    { ...original, containerName: 'atlas-id' },
    { ...original, containerName: 'legacy-atlas', agentId: 'another-id', activeBindings: bindings('4605', '') });
  assert.equal((await syncCaddy(m.options)).ok, true);
  const text = m.files.get(config.file).text;
  const assignments = readAssignments(text, config.domain);
  const routes = readManagedRoutes(text, config.domain);
  assert.deepEqual(assignments.get('atlas-id'), { base: 'atlas-id', name: 'legacy-atlas', id: 'atlas-id' });
  assert.deepEqual(assignments.get('legacy-atlas'), { base: 'legacy-atlas', name: 'legacy-atlas-2', id: 'another-id' });
  assert.equal(routes.get('legacy-atlas'), 3700);
  assert.equal(routes.get('legacy-atlas-2'), 4605);
  assert.equal((await syncCaddy(m.options)).changed, false);
});

test('DELETE awaits route removal after Docker removal and continues on failure or timeout', async () => {
  for (const outcome of ['ok', 'failed', 'rejected', 'timeout', 'off']) {
    const effects = [];
    let finishSync;
    let expire;
    const pending = new Promise(resolve => { finishSync = resolve; });
    const route = loadRoute('app/api/agents/[id]/route.ts', {
      process: { env: outcome === 'off' ? {} : env },
      console: { warn: () => effects.push('warn') },
      setTimeout: (fn, ms) => { assert.equal(ms, 20_000); expire = fn; return 1; },
      clearTimeout: () => { expire = undefined; },
    }, {
      'next/server': { NextResponse: Response },
      'child_process': { execSync: command => effects.push(command.startsWith('docker rm') ? 'remove' : 'volume') },
      fs: {}, path: {}, 'better-sqlite3': {},
      '@/lib/container': { isValidAgentId: () => true, resolveAgentedContainer: () => 'fixture' },
      '@/lib/agent-busy': { agentBusyReason: async () => null },
      '@/lib/agent-edit': {},
      '@/lib/rev4a-paths': {},
      '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
      '@/lib/credentials/assignments': { deleteAssignmentsForAgent: () => 0 },
      '@/lib/backups-volume': { deleteAgentBackups: async () => [] },
      '@/lib/domain-sync': { syncDomainRoutes: async name => {
        assert.equal(name, 'fixture');
        effects.push('sync');
        if (outcome === 'rejected') throw new Error('Sync rejected');
        return pending;
      } },
    });
    const result = route.DELETE(new Request('http://localhost'), { params: Promise.resolve({ id: 'fixture' }) });
    if (outcome !== 'off' && outcome !== 'rejected') {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(effects, ['remove', 'sync']);
      if (outcome === 'timeout') expire();
      else finishSync({ ok: outcome === 'ok' });
    }
    assert.equal((await result).status, 200, outcome);
    assert.equal(expire, undefined);
    assert.deepEqual(effects, outcome === 'off' ? ['remove', 'volume']
      : outcome === 'ok' ? ['remove', 'sync', 'volume'] : ['remove', 'sync', 'warn', 'volume']);
  }
});

test('Caddy sync removes routes for paused and restarting containers with live bindings', async () => {
  const m = mockRuntime({ initial: { [config.file]: golden(3) },
    agents: [{ ...fleet[0], paused: true }, { ...fleet[1], restarting: true }, fleet[2]] });
  assert.deepEqual(await syncCaddy(m.options), { ok: true, changed: true, routes: 1 });
  assert.deepEqual([...readManagedRoutes(m.files.get(config.file).text, config.domain)], [['relay', 3720]]);
});

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
  assert.match(content, /\thandle @old \{\n\t\t@old_manifest path \/manifest\.webmanifest\n/);
  t.diagnostic(`Trusted remote peer forwarding loopback: ${trustedRemote}; stale stopped route: ${staleStatus}; started route: ${startedStatus}`);
  content = golden(3);
  currentFleet = fleet.slice(1);
  assert.equal(await request('atlas.rev4a.example.com'), 404);
  currentFleet = [{ ...fleet[0], activeBindings: bindings('3700', '3901') }, ...fleet.slice(1)];
  assert.equal(await request('atlas-3001.rev4a.example.com'), 404);
  assert.equal(await request('atlas.rev4a.example.com'), 200);
  currentFleet = [{ ...fleet[0], paused: true }, ...fleet.slice(1)];
  assert.equal(await request('atlas.rev4a.example.com'), 404, 'paused despite Running and matching binding');
  assert.equal(await request('atlas-3001.rev4a.example.com'), 404);
  currentFleet = fleet;
  content = legacyCaddyfile(3);
  assert.equal(await request('atlas.rev4a.example.com'), 200);
  content = golden(3) + RELOAD_UNCONFIRMED;
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

test('failed setup validation preserves the original main and environment and keeps the backup', async () => {
  const m = mockRuntime({ initial: { [config.main]: previous, [envFile]: { text: 'EXAMPLE=value\n', mode: 0o600 } }, failure: 'validate' });
  await assert.rejects(setupDomain({ ...m.options, ...root, args }), /validate/);
  assert.equal(m.files.get(config.main).text, previous);
  assert.equal(m.files.get(envFile).text, 'EXAMPLE=value\n');
  assert.equal(m.files.get(config.file).text, domain.emptyCaddyfile());
  assert.ok([...m.files.keys()].some(file => file.includes('.bak-')));
});

test('setup reload failure restores the managed import and adopted main site before one rollback reload', async () => {
  const originalMain = previous.replace('3740', '8080') + mainImport;
  const originalManaged = domain.emptyCaddyfile();
  const m = mockRuntime({ agents: [], initial: { [config.main]: originalMain, [config.file]: originalManaged,
    [envFile]: { text: 'EXAMPLE=value\n', mode: 0o600 } } });
  const reloads = [];
  let activeUpstream = 8080;
  const run = async (program, argv, options) => {
    const result = await m.options.run(program, argv, options);
    if (argv[0] !== 'reload') return result;
    const main = m.files.get(config.main).text;
    const managed = m.files.get(config.file).text;
    reloads.push({ main, managed });
    const site = /^rev4a\.example\.com \{\s*reverse_proxy 127\.0\.0\.1:(\d+)/m;
    activeUpstream = Number(site.exec(main)?.[1] ?? site.exec(managed)?.[1]);
    if (reloads.length === 1) {
      assert.equal(activeUpstream, 3740);
      throw new Error('Candidate reload timed out after applying');
    }
    return result;
  };
  await assert.rejects(setupDomain({ ...m.options, ...root, args, run }), /Candidate reload timed out/);
  assert.equal(reloads.length, 2);
  assert.equal(reloads[1].main, originalMain);
  assert.equal(reloads[1].managed, originalManaged);
  assert.equal(activeUpstream, 8080);
  assert.equal(m.files.get(config.file).text, originalManaged);
  assert.equal(m.files.get(envFile).text, 'EXAMPLE=value\n');
});

test('unconfirmed first setup keeps Domain keys and reserves the candidate before Rev4a restarts', async () => {
  const agents = [{ ...fleet[0], activeBindings: bindings('4600', '') }];
  const main = '/custom/Caddyfile';
  const file = '/custom/rev4a.caddy';
  const setupEnv = { REV4A_CADDY_MAIN: main, REV4A_CADDY_FILE: file, PORT: '3740' };
  const m = mockRuntime({ agents, initial: { [main]: previous, [envFile]: 'EXAMPLE=value\n' } });
  let reloads = 0;
  let live;
  const run = async (program, argv) => {
    assert.equal(program, 'caddy');
    if (argv[0] === 'reload') {
      assert.deepEqual(argv.slice(1), ['--config', main, '--adapter', 'caddyfile']);
      if (++reloads === 1) {
        live = domain.readRouteReservations(m.files.get(file).text);
        throw new Error('Candidate reload timed out after applying');
      }
      assert.equal(m.files.get(main).text, previous);
      assert.equal(m.files.get(file).text, domain.emptyCaddyfile());
      throw new Error('Rollback reload failed');
    }
    assert.ok(['version', 'validate'].includes(argv[0]));
    return '';
  };
  await assert.rejects(setupDomain({ ...m.options, ...root, args, run, env: setupEnv }), error => {
    assert.match(error.message, /Domain settings were kept/);
    assert.ok(error.message.includes(`sudo caddy reload --config ${main} --adapter caddyfile`));
    assert.ok(error.message.includes(`remove the import of ${file}`));
    return true;
  });
  assert.equal(reloads, 2);
  assert.equal(live.routes.get('atlas'), 4600);
  const content = m.files.get(file).text;
  assert.ok(content.endsWith('\n' + RELOAD_UNCONFIRMED));
  assert.deepEqual(domain.readRouteReservations(content), live);
  const saved = envEditor.parseEnvValues(m.files.get(envFile).text);
  assert.equal(saved.REV4A_DOMAIN, config.domain);
  assert.equal(saved.REV4A_CADDY_MAIN, main);
  assert.equal(saved.REV4A_CADDY_FILE, file);
  assert.equal(saved.EXAMPLE, 'value');
  // The allocator's Docker inventory is empty, as it would be after deleting the agent.
  for (const settings of [{}, saved]) {
    assert.deepEqual([...await loadAllocator(m, { settings }).getUsedHostPorts()].sort((a, b) => a - b), [3740, 4600]);
  }
});

test('sync and setup refuse to run unlocked when flock is missing', async () => {
  const m = mockRuntime({ initial: { [config.main]: previous } });
  const { withFileDirectoryLock } = loadRoute('lib/file-lock.js', {}, {
    'node:fs/promises': {},
    'node:path': require('node:path'),
    'node:child_process': { spawn: command => {
      assert.equal(command, 'flock');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', Object.assign(new Error('Missing flock'), { code: 'ENOENT' })));
      return child;
    } },
  });
  const io = { ...m.options.io, open: async (file, flags) => {
    assert.equal(file, dirname(config.file));
    assert.equal(flags, 'r');
    return { fd: 3, close: async () => {} };
  } };
  const options = { ...m.options, io, withLock: withFileDirectoryLock };
  assert.match((await syncCaddy(options)).error, /flock is required/);
  await assert.rejects(setupDomain({ ...options, ...root, args }), /flock is required/);
  assert.deepEqual(m.operations, []);
  assert.equal(m.dockerReads(), 0);
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
  let reloads = 0;
  const run = async (program, argv, options) => {
    if (program === 'caddy' && argv[0] === 'reload' && reloads++ === 0) {
      const response = await editor.saveEnvironment({ env: { REV4A_LISTEN: '127.0.0.1', REV4A_OPERATOR_SETTING: '1' } });
      assert.equal(response.status, 200);
      m.files.get(envFile).text += 'NEW_OPERATOR_SETTING=1\n';
      m.files.get(config.main).text += '# operator change during reload\n';
    }
    return m.options.run(program, argv, options);
  };
  await assert.rejects(setupDomain({ ...m.options, ...root, args, run }), /CADDY ROLLBACK UNCONFIRMED.*Domain settings were kept/);
  const saved = envEditor.parseEnvValues(m.files.get(envFile).text);
  assert.equal(saved.REV4A_LISTEN, '127.0.0.1');
  assert.equal(saved.REV4A_DOMAIN, config.domain);
  assert.equal(saved.REV4A_OPERATOR_SETTING, '1');
  assert.equal(saved.NEW_OPERATOR_SETTING, '1');
  assert.equal(m.files.get(config.main).text, planCaddyfile(previous, config).content + '# operator change during reload\n');
  assert.equal(m.files.get(config.file).text, golden(3) + RELOAD_UNCONFIRMED);
  assert.equal(reloads, 1);
  assert.ok(m.messages.some(message => message.includes('The main Caddyfile changed during setup')));
  t.diagnostic('Config save: 200. The later Config values, Domain settings and the operator Caddyfile edit survived.');
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

test('non-root and non-Linux are refused and dry-run uses the service directory and port without writes or commands', async t => {
  const m = mockRuntime({ initial: { [config.main]: previous } });
  await assert.rejects(setupDomain({ ...m.options, ...root, args, uid: 1000 }), /requires root/);
  await assert.rejects(setupDomain({ ...m.options, ...root, args, platform: 'darwin' }), /requires Linux/);
  await setupDomain({ ...m.options, ...root, args: [...args, '--dry-run'] });
  assert.deepEqual(m.commands, []);
  assert.deepEqual(m.operations, []);
  assert.equal(m.dockerReads(), 0);
  assert.equal(m.files.get(config.main).text, previous);
  assert.ok(m.messages.some(message => message.includes('Comment out and preserve')));
  const customDir = '/service/rev4a';
  const custom = mockRuntime({ agents: [], initial: { [config.main]: previous, [`${customDir}/.env`]: 'PORT=3740\n' } });
  const customEnv = { ...env, PORT: '8080', REV4A_DATA_DIR: customDir };
  await setupDomain({ ...custom.options, ...root, args: [...args, '--dry-run'], dataDir: customDir, env: customEnv });
  assert.deepEqual([custom.commands, custom.operations, custom.dockerReads()], [[], [], 0]);
  assert.ok(custom.messages.includes(`Set REV4A_DOMAIN in ${customDir}/.env.`));
  assert.deepEqual(await setupDomain({ ...custom.options, ...root, args, dataDir: customDir, env: customEnv }), { changed: true });
  assert.ok(custom.files.get(`${customDir}/.env`).text.includes(`REV4A_DOMAIN=${config.domain}`));
  assert.match(custom.files.get(config.main).text, /ask http:\/\/127\.0\.0\.1:8080\/api\/domain\/ask/);
  assert.match(custom.files.get(config.file).text, /reverse_proxy 127\.0\.0\.1:8080/);
  const savedPort = mockRuntime({ agents: [], initial: { [config.main]: previous, [envFile]: 'PORT=7070\n' } });
  assert.deepEqual(await setupDomain({ ...savedPort.options, ...root, args }), { changed: true });
  assert.match(savedPort.files.get(config.main).text, /ask http:\/\/127\.0\.0\.1:7070\/api\/domain\/ask/);
  assert.match(savedPort.files.get(config.file).text, /reverse_proxy 127\.0\.0\.1:7070/);
  t.diagnostic('Service-matched dry run: /service/rev4a/.env, subprocesses=0, writes=0. Mock setup: callback and dashboard upstream 127.0.0.1:8080.');
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

test('setup prefers explicit service paths and port over the saved environment', async () => {
  const caddyMain = '/service/caddy/Caddyfile';
  const caddyFile = '/service/caddy/rev4a.caddy';
  const m = mockRuntime({ agents: [], initial: { [caddyMain]: previous, [envFile]:
    'PORT=9000\nREV4A_CADDY_MAIN=/saved/Caddyfile\nREV4A_CADDY_FILE=/saved/rev4a.caddy\n' } });
  const service = { ...env, PORT: '3740', REV4A_CADDY_MAIN: caddyMain, REV4A_CADDY_FILE: caddyFile };
  await setupDomain({ ...m.options, ...root, env: service, args: [...args, '--dry-run'] });
  assert.ok(m.messages.includes(`Back up ${caddyMain} before editing it.`));
  assert.ok(m.messages.includes(`Sync ${caddyFile} and validate ${caddyMain} before any reload.`));
  const run = async (_command, [action, ...argv]) => {
    if (action !== 'version') assert.deepEqual(argv, ['--config', caddyMain, '--adapter', 'caddyfile']);
    return '';
  };
  await setupDomain({ ...m.options, ...root, env: service, args, run });
  assert.match(m.files.get(caddyMain).text, /ask http:\/\/127\.0\.0\.1:3740\/api\/domain\/ask/);
  assert.equal(m.files.get(caddyFile).text, golden(0));
});

test('a failed first sync attempts a rollback reload with an empty import', async () => {
  const m = mockRuntime({ failure: 'reload' });
  const reloads = [];
  const run = async (program, argv, options) => {
    if (program === 'caddy' && argv[0] === 'reload') reloads.push(m.files.get(config.file)?.text ?? '');
    return m.options.run(program, argv, options);
  };
  const result = await syncCaddy({ ...m.options, run });
  assert.equal(result.ok, false);
  assert.equal(reloads.length, 2);
  assert.deepEqual(reloads, [golden(3) + RELOAD_UNCONFIRMED, domain.emptyCaddyfile()]);
  assert.equal(m.files.get(config.file).text, reloads[0]);
  assert.ok(m.messages.some(message => message.includes('CADDY ROLLBACK UNCONFIRMED')));
});
