#!/usr/bin/env node
/** NET-1a pure decisions and HTTP boundary; no Docker, network or real .env writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    assert.ok(name in dependencies, `Unexpected import ${name} in ${file}`); return dependencies[name];
  }, Error, console, ...globals });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': { isValidCronJobId: () => true } });
const access = load('lib/remote-access.ts', { './control-ui-navigation': navigation });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok   ${name}`); }
await test('preset table and trusted proxies only gain missing exact entries', () => {
  for (const preset of ['local', 'direct', 'domain']) {
    for (const proxies of ['', '192.0.2.8/32', '127.0.0.1', '::1', ' 127.0.0.1 , ::1 ', '192.0.2.1,', '192.0.2.1,127.0.0.1,::1']) {
      const settings = { REV4A_TRUSTED_PROXIES: proxies };
      const edits = plain(access.presetEdits(preset, settings));
      assert.equal(edits.REV4A_LISTEN, preset === 'direct' ? 'all' : 'local');
      assert.equal(edits.REV4A_AGENT_PORTS_LISTEN, edits.REV4A_LISTEN);
      if (preset === 'domain') {
        assert.ok(edits.REV4A_TRUSTED_PROXIES.startsWith(proxies));
        for (const ip of ['127.0.0.1', '::1']) assert.equal(edits.REV4A_TRUSTED_PROXIES.split(',').filter((s) => s.trim() === ip).length, 1);
        assert.deepEqual(plain(access.presetEdits('domain', edits)), edits, 'idempotent append');
      } else assert.equal(edits.REV4A_TRUSTED_PROXIES, undefined);
      assert.equal(settings.REV4A_TRUSTED_PROXIES, proxies);
    }
  }
});
await test('guard matrix: loopback, LAN, http/https hostnames and IPv6 literals', () => {
  for (const hostname of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.24.2.8', '[::1]', '::1', '192.168.1.8', 'example.com', '[2001:db8::5]', '2001:db8::5']) {
    for (const protocol of ['http:', 'https:']) {
      const loopback = ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.24.2.8', '[::1]', '::1'].includes(hostname);

      const location = { protocol, hostname, port: '3740' };
      const canonical = loopback && hostname !== '127.24.2.8';
      const local = access.presetGuard('local', location);
      assert.equal(local.allowed, canonical); assert.equal(local.needsConfirm, false);
      assert.equal(!!local.reason, !canonical);
      assert.deepEqual(plain(access.presetGuard('direct', location)), { allowed: true, needsConfirm: false, reason: '' });
      assert.deepEqual(plain(access.presetGuard('domain', location)), { allowed: true, needsConfirm: true, reason: '' });
      assert.equal(access.showLanNotice(hostname, 'all'), loopback);
      assert.equal(access.showLanNotice(hostname, 'local'), false); assert.equal(access.showLanNotice(hostname, 'address'), false);
    }
  }
  for (const host of ['127.0.0.999', 'localhost.evil', 'evil.localhost', '127.evil.com']) assert.equal(access.isLoopbackHost(host), false);
});
await test('current mode: explicit keys, active panel, keep/address/pending and Custom mixtures', () => {
  const local = access.presetEdits('local', {}); const direct = access.presetEdits('direct', {}); const domain = access.presetEdits('domain', {});
  for (const [panel, agents, settings, expected] of [
    ['local', 'local', local, 'local'], ['local', 'local', domain, 'domain'], ['all', 'all', direct, 'direct'],
    ['all', 'local', local, 'custom'], ['local', 'all', direct, 'custom'], ['all', 'keep', {}, 'default'],
    ['address', 'address', { REV4A_LISTEN: '192.0.2.1', REV4A_AGENT_PORTS_LISTEN: '192.0.2.1' }, 'custom'],
    ['local', 'local', { REV4A_LISTEN: 'garbage', REV4A_AGENT_PORTS_LISTEN: 'local' }, 'custom'],
    ['all', 'all', { REV4A_LISTEN: ' ALL ', REV4A_AGENT_PORTS_LISTEN: 'all' }, 'direct'],
  ]) assert.equal(access.currentAccessMode(panel, agents, settings), expected);
});

await test('pending panel settings include cleared defaults but preserve already active custom IPs', () => {
  for (const [panel, setting, pending] of [
    [{ mode: 'address', addresses: ['10.0.0.5', '127.0.0.1'] }, '10.0.0.5', false],
    [{ mode: 'address', addresses: ['::1'] }, '[::1]', false],
    [{ mode: 'address', addresses: ['10.0.0.5'] }, '10.0.0.6', true],
    [{ mode: 'local', addresses: [] }, '', true],
    [{ mode: 'all', addresses: [] }, undefined, false],
    [{ mode: 'all', addresses: [] }, 'local', true],
  ]) assert.equal(access.panelRestartPending(panel, setting), pending);
  const saved = access.presetEdits('domain', {});
  const local = access.presetEdits('local', {});
  assert.equal(access.accessRestartPending({ mode: 'local', addresses: ['127.0.0.1'] }, saved, local), true);
  assert.equal(access.accessRestartPending({ mode: 'local', addresses: ['127.0.0.1'] }, saved, saved), false);
});

function harness(initial = '# keep\nUNRELATED=keep\nPORT=3740\n', inherited = {}) {
  let content = initial; let denied = null; const effects = [];
  const dependencies = { 'next/server': { NextResponse: { json: (body, opts) => ({ body: plain(body), status: opts?.status ?? 200 }) } },
    fs: { readFileSync: () => content, writeFileSync: (_file, next, options) => { assert.equal(options.mode, 0o600); content = next; effects.push('write'); },
      chmodSync: () => effects.push('chmod'), statSync: () => ({ mode: 0o600 }) },
    child_process: { execSync: () => effects.push('reload') }, '@/lib/rev4a-paths': { ENV_FILE: '/mock/.env' },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied }, '@/lib/env-file': require('../lib/env-file.js'), '@/lib/file-lock': require('../lib/file-lock.js'),
    '@/lib/listen-addresses': require('../lib/listen-addresses.js'), '@/lib/remote-access': access };
  const globals = { process: { env: inherited } };
  dependencies['@/lib/env-edit'] = load('lib/env-edit.ts', dependencies, globals);
  dependencies['@/lib/remote-access-server'] = load('lib/remote-access-server.ts', dependencies, globals);
  const api = load('app/api/system/remote-access/route.ts', dependencies, globals);
  return { api, effects, get content() { return content; }, deny: () => { denied = { status: 401 }; },
    put: (preset, location = { protocol: 'https:', hostname: 'panel.example.com' }, proxyConfirmed = false, edits) => api.PUT({ json: async () => ({ preset, location, proxyConfirmed,
      edits: edits || access.presetEdits(preset, dependencies['@/lib/remote-access-server'].readAccessSettings()) }) }) };
}
await test('preset API uses shared edits, keeps unrelated lines and proxy entries, no writes on GET or guard failure', async () => {
  const original = '# keep\r\nUNRELATED=keep\r\nPORT=3740\r\nREV4A_TRUSTED_PROXIES=192.0.2.1\r\nREV4A_PASSWORD=hidden\r\n'; // secret-ok
  const h = harness(original);
  const read = await h.api.GET({}); assert.equal(read.status, 200); assert.deepEqual(h.effects, []);
  assert.equal(read.body.settings.REV4A_TRUSTED_PROXIES, '192.0.2.1'); assert.ok(!JSON.stringify(read.body).includes('hidden'));
  assert.equal((await h.put('local')).status, 400); assert.equal(h.content, original);
  assert.equal((await h.put('domain', { protocol: 'http:', hostname: '192.0.2.3' })).status, 400); assert.equal(h.content, original);
  assert.equal((await h.put('domain', { protocol: 'http:', hostname: '192.0.2.3' }, true)).status, 200);
  const saved = (await h.api.GET({})).body;
  assert.equal(saved.startupSettings.REV4A_TRUSTED_PROXIES, '');
  assert.equal(access.accessRestartPending({ mode: 'local', addresses: ['127.0.0.1'] }, saved.settings, saved.startupSettings), true);
  assert.ok(h.content.startsWith(original.replace('REV4A_TRUSTED_PROXIES=192.0.2.1', 'REV4A_TRUSTED_PROXIES=192.0.2.1,127.0.0.1,::1')));
  const changed = h.content; assert.equal((await h.put('domain', undefined, true)).status, 200); assert.equal(h.content, changed);
  h.deny(); assert.equal((await h.api.GET({})).status, 401); assert.equal((await h.put('direct')).status, 401);
});
await test('stale confirmation is 409; ambiguous .env is 409; inherited keys are deliberately persisted', async () => {
  const stale = harness('REV4A_TRUSTED_PROXIES=192.0.2.1\n');
  assert.equal((await stale.put('domain', undefined, true, access.presetEdits('domain', {}))).status, 409); assert.deepEqual(stale.effects, []);
  const ambiguous = harness('NOTE="first\nlast"\n');
  assert.equal((await ambiguous.put('direct')).status, 409); assert.deepEqual(ambiguous.effects, []);
  const inherited = harness('', { REV4A_LISTEN: 'all', REV4A_AGENT_PORTS_LISTEN: 'all' });
  assert.equal((await inherited.put('direct')).status, 200); assert.match(inherited.content, /REV4A_LISTEN=all/);
});

await test('wizard step order includes skippable access after welcome; a completed install hydrates to done', async () => {
  const values = []; const effects = []; let index = 0; let isDone = false;
  const react = { useState: (initial) => { const slot = index++; if (!(slot in values)) values[slot] = initial; return [values[slot], (next) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }]; },
    useCallback: (fn) => fn, useEffect: (fn) => { const slot = index++; if (!(slot in values)) { values[slot] = true; effects.push(fn); } } };
  const wizard = load('app/wizard/useWizard.ts', { react, '../lib/models-context': { useModels: () => ({ refresh: () => {} }) },
    './storage': { isWizardComplete: async () => isDone, markWizardComplete: async () => true, resetWizard: async () => {} } });
  const render = () => { index = 0; return wizard.useWizard(); };
  assert.deepEqual(plain(wizard.STEP_ORDER), ['welcome', 'access', 'providers', 'agents', 'done']);
  let w = render(); await w.goNext(); w = render(); assert.equal(w.step, 'access'); w.skip(); w = render(); assert.equal(w.step, 'providers');
  values.length = 0; effects.length = 0; isDone = true; render(); effects.splice(0).forEach((fn) => fn());
  for (let i = 0; i < 5; i++) await Promise.resolve();
  w = render(); assert.equal(w.step, 'done'); assert.equal(w.hydrated, true);
});
await test('Done uses authenticated restart, preserves inherited password support, and exits the manual-restart path', async () => {
  for (const pending of [false, true, 'manual']) {
    const hooks = []; const effects = []; const calls = []; let index = 0;
    const storage = new Map(pending ? [['rev4a-access-choice', 'local']] : []);
    const react = { useState: (initial) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], (value) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
      useRef: (initial) => { const slot = index++; return hooks[slot] ??= { current: initial }; },
      useEffect: (fn) => { const slot = index++; if (!(slot in hooks)) { hooks[slot] = true; effects.push(fn); } } };
    const client = load('app/wizard/PageClient.tsx', { react, 'react/jsx-runtime': require('react/jsx-runtime'),
      'next/navigation': { useRouter: () => ({ push: (url) => calls.push('navigate:' + url) }) }, 'next/link': () => {},
      '../components/ui': { Button: () => {}, Surface: () => {} }, './AccessStep': { AccessStep: () => {} }, './icons': {},
      '@/lib/remote-access': access,
      '@/lib/session-cookie-check': { checkSessionCookie: async () => { calls.push('cookie-check'); return null; } },
      './useWizard': { useWizard: () => ({ step: 'done', stepIndex: 4, hydrated: true, providerKeys: {}, completeAll: async () => { calls.push('complete'); return true; } }) },
    }, { AbortController, window: { location: { protocol: 'http:', hostname: 'localhost', port: '3740' } },
      sessionStorage: { getItem: (key) => storage.get(key), removeItem: (key) => storage.delete(key) },
      fetch: async (url) => { calls.push(url); const manual = pending === 'manual' && url === '/api/config/restart';
        return { ok: !manual, status: manual ? 409 : 200, json: async () => manual ? { error: 'Restart Rev4a by hand to apply' } : { status: 'ok', restarting: true, mode: 'supervisor' } }; } });
    const render = () => { index = 0; return client.default(); };
    render(); effects.splice(0).forEach((fn) => fn());
    const done = render().props.children.find((child) => child && child.type.name === 'DoneStep');
    const first = done.props.onComplete(); const repeated = done.props.onComplete(); await Promise.all([first, repeated]);
    if (pending === 'manual') {
      const nextDone = render().props.children.find((child) => child && child.type.name === 'DoneStep');
      assert.equal(nextDone.props.manualRestart, true); assert.equal(nextDone.props.error, 'Restart Rev4a by hand to apply');
      await nextDone.props.onComplete();
      console.log('WIZARD_NEXT_DEV manualMessage "Restart Rev4a by hand to apply" restartRequests 1 navigate /');
    }
    assert.deepEqual(calls, pending ? ['cookie-check', '/api/system/remote-access', 'complete', '/api/config/restart', 'navigate:/'] : ['cookie-check', 'complete', 'navigate:/']);
    assert.equal(storage.get('rev4a-access-choice'), undefined);
  }
});

await test('wizard choices can change or skip before Done without writing settings', async () => {
  const values = []; const effects = []; let index = 0; const calls = [];
  const react = { useState: (initial) => { const slot = index++; if (!(slot in values)) values[slot] = initial;
    return [values[slot], (next) => { values[slot] = next; }]; },
    useEffect: (fn) => { const slot = index++; if (!(slot in values)) { values[slot] = true; effects.push(fn); } } };
  const ui = { Button: () => {}, TemplateOption: () => {} };
  const client = load('app/wizard/AccessStep.tsx', { react, 'react/jsx-runtime': require('react/jsx-runtime'), '../components/ui': ui, '../remote-access/PresetOption': { PresetOption: ui.TemplateOption }, '@/lib/remote-access': access },
    { window: { location: { protocol: 'http:', hostname: 'localhost', port: '3740' } }, fetch: () => assert.fail('Access must defer writes to Done') });
  const props = { localChosen: false, onChoice: (value) => calls.push(value), onNext: () => calls.push('next'), onSkip: () => calls.push('skip') };
  const render = () => { index = 0; return client.AccessStep(props).props.children.filter(Boolean); };
  render(); effects.splice(0).forEach((fn) => fn());
  for (const id of ['Only this computer', 'From other devices', 'By IP for now (not secure)']) render().find((node) => node.props?.id === id).props.onClick();
  const buttons = render().find((node) => node.props?.className === 'wizard-actions').props.children;
  buttons[1].props.onClick(); buttons[0].props.onClick();
  assert.deepEqual(calls, [true, false, false, false, 'next', false, 'skip']);
  console.log('WIZARD_CHANGED_CHOICE local,devices,ip,skip writes 0 deferredLocal false');
});

await test('malformed JSON returns 400 without writes; guard rejects noncanonical loopback with reconnect URL', async () => {
  const h = harness();
  const response = await h.api.PUT({ json: async () => { throw new SyntaxError('Bad JSON'); } });
  assert.equal(response.status, 400); assert.deepEqual(h.effects, []);
  console.log('INVALID_PRESET_JSON', JSON.stringify(response));
  const location = { protocol: 'http:', hostname: '127.0.0.2', port: '3740' };
  const guard = access.presetGuard('local', location);
  assert.equal(guard.allowed, false); assert.match(guard.reason, /http:\/\/127\.0\.0\.1:3740/);
  assert.equal((await h.put('local', location)).status, 400);
  console.log('NONCANONICAL_LOOPBACK', JSON.stringify(guard), 'listeners', JSON.stringify(require('../lib/listen-addresses.js').listenAddresses('local', { platform: 'darwin', hasIpv6: true }).addresses));
  assert.equal(access.presetGuard('local', { protocol: 'http:', hostname: 'localhost.' }).allowed, true);
  assert.equal(access.showLanNotice('localhost.', 'all'), true);
  assert.equal(navigation.controlUiExposesSession('http:', 'localhost.'), false);
  console.log('TRAILING_DOT_LOCALHOST localAllowed true lanNotice true exposesSession false');
});

await test('100,000-line legacy environment keeps unrelated bytes; repeated Domain application is idempotent', async () => {
  const original = Array.from({ length: 100000 }, (_, index) => `LEGACY_${index}=kept-${index}\n`).join('');
  const h = harness(original); const start = Date.now();
  assert.equal((await h.put('domain', undefined, true)).status, 200);
  assert.ok(h.content.startsWith(original)); const next = h.content;
  assert.equal((await h.put('domain', undefined, true)).status, 200); assert.equal(h.content, next);
  console.log(`LARGE_OLD_ENV ${original.length} bytes 200 prefixPreserved true repeatUnchanged true ms ${Date.now() - start}`);
});

console.log(`\n${passed} remote access checks passed`);
