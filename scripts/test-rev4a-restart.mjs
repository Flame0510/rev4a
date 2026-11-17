#!/usr/bin/env node
/** All files/processes/after callbacks mocked: never starts or stops a service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies, process, logger = console) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name];
  }, process, console: logger, Error });
  return module.exports;
}
let passed = 0;
function harness(env = {}, cgroup = '', writable = true, uid = 1000, fail = '', platform = 'linux') {
  const effects = []; const logs = [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture';
  env = { REV4A_DATA_DIR: '/mock/config', ...env };
  const directory = paths.join(env.REV4A_DATA_DIR || paths.join(home, '.config', 'rev4a'), 'data');
  const helper = load('lib/rev4a-restart.ts', {
    fs: { constants: { W_OK: 2 }, readFileSync: (file) => { assert.equal(file, '/proc/self/cgroup'); return cgroup; },
      accessSync: (file, flag) => { assert.equal(file, directory); assert.equal(flag, 2); if (!writable) throw new Error('EACCES'); },
      writeFileSync: (...args) => effects.push(['write', ...args]) },
    child_process: { execFileSync: (...args) => {
      effects.push(['exec', ...args]);
      if (args[1].includes('restart')) {
        if (fail === 'restart-timeout') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
        if (fail === 'restart-timedOut') throw Object.assign(new Error('timed out'), { timedOut: true, signal: 'SIGTERM', status: null });
        if (fail === 'restart-killed') throw Object.assign(new Error('killed'), { signal: 'SIGTERM', status: null });
      }
      if (args[1].includes(fail)) throw new Error('refused');
    } }, path: paths, os: { homedir: () => home },
  }, { env, platform, getuid: () => uid }, { warn: (message) => logs.push(message), error: (message) => logs.push(message) });
  return { helper, effects, logs, home, env, paths };
}
// Evaluate only the launcher's path declarations, never its entry point or service code.
const launcher = fs.readFileSync(path.join(root, 'bin/rev4a.js'), 'utf8');
for (const platform of ['linux', 'darwin', 'win32']) for (const override of [false, true]) {
  const h = harness({ REV4A_SUPERVISED: '1', REV4A_DATA_DIR: override ? (platform === 'win32' ? 'D:\\Rev4a' : '/custom/rev4a') : undefined, APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' }, '', true, 1000, '', platform);
  const declarations = ['CONFIG_DIR', 'DATA_DIR', 'RESTART_FLAG'].map((name) => {
    const match = launcher.match(new RegExp(`^\\s*const ${name} = (.+);$`, 'm'));
    assert.ok(match, name); return `const ${name} = ${match[1]};`;
  }).join('\n');
  const watched = vm.runInNewContext(declarations + '\nRESTART_FLAG;', { process: { env: h.env }, os: { homedir: () => h.home }, join: h.paths.join });
  h.helper.prepareRestart().run();
  assert.equal(h.effects[0][1], watched);
  passed++; console.log(`ok   ${platform} override=${override}: restart flag matches launcher watcher`);
}
for (const [name, env, cgroup, expected] of [
  ['own unit', { INVOCATION_ID: 'boot' }, '0::/system.slice/rev4a.service', 'systemd'],
  ['unit child cgroup', { INVOCATION_ID: 'boot', REV4A_SUPERVISED: '1' }, '0::/system.slice/rev4a.service/child', 'systemd'],
  ['supervisor on Mac/PC', { REV4A_SUPERVISED: '1' }, '', 'supervisor'],
  ['another active unit does not own this process', { INVOCATION_ID: 'other', REV4A_SUPERVISED: '1' }, '0::/system.slice/other.service', 'supervisor'],
  ['not an invocation', {}, '0::/system.slice/rev4a.service', null],
  ['next dev', {}, '', null],
  ['similar unit name', { INVOCATION_ID: 'boot' }, '0::/system.slice/rev4a.service-evil', null],
  ['user unit is not the system service', { INVOCATION_ID: 'boot' }, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/rev4a.service', null],
  ['supervised user unit uses flag', { INVOCATION_ID: 'boot', REV4A_SUPERVISED: '1' }, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/rev4a.service', 'supervisor'],
]) {
  const h = harness(env, cgroup);
  if (!expected) assert.throws(h.helper.prepareRestart, /Restart Rev4a by hand to apply/);
  else {
    const plan = h.helper.prepareRestart(); assert.equal(plan.mode, expected);
    assert.deepEqual(h.effects, [], 'preparation never changes anything'); plan.run();
    if (expected === 'systemd') {
      assert.equal(h.effects[0][0], 'exec'); assert.equal(h.effects[0][1], 'sudo');
      assert.deepEqual(Array.from(h.effects[0][2]), ['-n', 'systemctl', 'daemon-reload']);
    } else { assert.deepEqual(h.effects[0].slice(0, 3), ['write', '/mock/config/data/.restart-flag', '']); assert.equal(h.effects[0][3].mode, 0o600); }
  }
  passed++; console.log(`ok   ${name}`);
}
const unavailable = harness({ REV4A_SUPERVISED: '1' }, '', false);
assert.throws(unavailable.helper.prepareRestart, /EACCES/); assert.deepEqual(unavailable.effects, []);
passed++; console.log('ok   unwritable data directory never claims to restart');

{
  // systemctl runs inside the unit: the stop it queued kills it with SIGTERM. That is success, not a refusal:
  // writing the flag here caused a second restart right after the first one.
  const h = harness({ INVOCATION_ID: 'boot', REV4A_SUPERVISED: '1' }, '0::/system.slice/rev4a.service', true, 0, 'restart-killed');
  h.helper.prepareRestart().run();
  assert.ok(!h.effects.some((e) => e[0] === 'write'), 'no flag after a signal');
  assert.deepEqual(h.logs, []);
  passed++; console.log('ok   a restart killed by its own unit stop writes no flag (no second restart)');
}
for (const fail of ['restart-timeout', 'restart-timedOut']) for (const supervised of [false, true]) {
  const h = harness({ INVOCATION_ID: 'boot', REV4A_SUPERVISED: supervised ? '1' : undefined }, '0::/system.slice/rev4a.service', true, 0, fail);
  const plan = h.helper.prepareRestart();
  if (supervised) plan.run();
  else assert.throws(plan.run, /timed out/);
  assert.ok(h.logs.includes('[restart] systemd restart failed'));
  assert.equal(h.effects.some((e) => e[0] === 'write'), supervised);
  assert.equal(h.logs.includes('[restart] requested supervisor restart instead'), supervised);
  passed++; console.log(`ok   ${fail} supervised=${supervised}: logged failure, ${supervised ? 'flag fallback' : 'error propagated'}`);
}
for (const uid of [0, 1000]) {
  const h = harness({ INVOCATION_ID: 'boot', REV4A_SUPERVISED: '1' }, '0::/system.slice/rev4a.service', true, uid, 'restart');
  const plan = h.helper.prepareRestart(); plan.run();
  assert.equal(h.effects[0][1], uid === 0 ? 'systemctl' : 'sudo');
  assert.ok(h.effects[0][2].includes('daemon-reload'));
  assert.equal(h.effects.at(-1)[0], 'write');
  console.log(`SYSTEMD_RESTART_REFUSED uid ${uid} command ${h.effects[0][1]} fallback ${h.effects.at(-1)[1]}`);
  passed++;
}
const reload = harness({ INVOCATION_ID: 'boot' }, '0::/system.slice/rev4a.service', true, 0, 'daemon-reload');
reload.helper.prepareRestart().run();
assert.deepEqual(Array.from(reload.effects.at(-1)[2]), ['restart', '--no-block', 'rev4a.service']);
passed++; console.log('ok   refused daemon-reload still attempts restart');

for (const route of ['config', 'setup']) {
  for (const mode of ['systemd', 'supervisor', 'neither']) {
    const h = harness(mode === 'systemd' ? { INVOCATION_ID: 'boot' } : mode === 'supervisor' ? { REV4A_SUPERVISED: '1' } : {}, '0::/system.slice/rev4a.service');
    let denied = null; const callbacks = [];
    const api = load(`app/api/${route}/restart/route.ts`, {
      'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) }, after: (fn) => callbacks.push(fn) },
      '@/lib/rev4a-auth': { requireAuthJWT: async () => denied, requireAuthIfConfigured: async () => denied },
      '@/lib/rev4a-restart': h.helper,
      fs: { existsSync: () => true, readFileSync: () => 'REV4A_PASSWORD=fixture-only\n' }, // secret-ok
      '@/lib/rev4a-paths': { ENV_FILE: '/mock/.env' }, '@/lib/env-file': require('../lib/env-file.js'),
    }, { env: {} });
    const response = await api.POST({}); assert.equal(response.status, mode === 'neither' ? 409 : 200);
    assert.deepEqual(h.effects, []); assert.equal(callbacks.length, mode === 'neither' ? 0 : 1);
    if (mode !== 'neither') {
      assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { status: 'ok', restarting: true, mode }); callbacks[0](); assert.equal(h.effects.length, mode === 'systemd' ? 2 : 1);
    } else assert.equal(response.body.error, 'Restart Rev4a by hand to apply');
    denied = { status: 401 }; assert.equal(await api.POST({}), denied);
    passed++; console.log(`ok   ${route} route: ${mode}, auth and response-before-restart`);
  }
}
for (const route of ['config', 'setup']) {
  const h = harness({ REV4A_SUPERVISED: '1' }); const callbacks = [];
  const api = load(`app/api/${route}/restart/route.ts`, {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) }, after: (fn) => callbacks.push(fn) },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null, requireAuthIfConfigured: async () => null },
    '@/lib/rev4a-restart': h.helper, fs: { existsSync: () => true, readFileSync: () => 'PORT=3740\n' },
    '@/lib/rev4a-paths': { ENV_FILE: '/mock/.env' }, '@/lib/env-file': require('../lib/env-file.js'),
  }, { env: { REV4A_PASSWORD: 'inherited-fixture' } }); // secret-ok
  const response = await api.POST({});
  assert.equal(response.status, route === 'config' ? 200 : 400);
  assert.equal(callbacks.length, route === 'config' ? 1 : 0);
  console.log(`INHERITED_PASSWORD_${route.toUpperCase()} ${JSON.stringify(response)} scheduled ${callbacks.length}`);
  passed++;
}
assert.ok(launcher.includes("console.log('[REV4A] Restarting…')"));
assert.ok(!launcher.includes('Restarting with updated binary'));
assert.match(launcher, /const DATA_DIR = join\(CONFIG_DIR, 'data'\)/);
assert.match(launcher, /const RESTART_FLAG = join\(DATA_DIR, '\.restart-flag'\)/);
assert.match(launcher, /childEnv\.REV4A_SUPERVISED = '1'/);
assert.ok(require('../lib/env-file.js').RUNTIME_ONLY_ENV_KEYS.includes('REV4A_SUPERVISED'));
for (const route of ['config', 'setup']) assert.doesNotMatch(fs.readFileSync(path.join(root, `app/api/${route}/restart/route.ts`), 'utf8'), /process\.kill|SIGTERM|execSync/);
console.log(`\n${passed} restart checks passed`);
