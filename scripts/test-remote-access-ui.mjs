#!/usr/bin/env node
/** Execute the real Remote access page and System summary with hooks and requests mocked, entirely offline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies, globals = {}, source = fs.readFileSync(path.join(root, file), 'utf8')) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; }, console, Error, ...globals });
  return module.exports;
}
const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': { isValidCronJobId: () => true } });
const access = load('lib/remote-access.ts', { './control-ui-navigation': navigation });
const ui = Object.fromEntries(['Button', 'Input', 'Switch', 'Modal', 'Surface', 'TemplateOption', 'Page', 'PageHeader', 'Pill', 'PropertyList', 'ItemList'].map((name) => [name, function primitive() {}]));
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const domainHost = 'rev4a.example.com';
const domainDnsUrl = `/api/domain/dns?domain=${domainHost}`;
const domainStatus = {
  domain: null, enabled: false, port: 3740, dataDir: '/root/.config/rev4a',
  caddy: { installed: false, managedFile: 'missing', imported: false, onDemandAsk: false, askTarget: 'missing' },
  listen: { panel: 'all', agents: 'keep' }, routes: 0, restartPending: false, serverAddresses: { ipv4: ['1.1.1.1'], ipv6: ['2606:4700::1111'] },
};
const activeDomain = { ...domainStatus, domain: domainHost, enabled: true, routes: 4,
  caddy: { installed: true, managedFile: 'ok', imported: true, onDemandAsk: true, askTarget: 'ok' } };
const samplePassword = 'fixture_password_value';
const dnsResult = { records: [
  { name: domainHost, type: 'A', expected: ['1.1.1.1'], found: ['1.1.1.1'], ok: true },
  { name: domainHost, type: 'AAAA', expected: ['2606:4700::1111'], found: [], ok: false },
  { name: `*.${domainHost}`, type: 'A', expected: ['1.1.1.2'], found: ['1.1.1.3'], ok: false },
  { name: `*.${domainHost}`, type: 'AAAA', expected: ['2606:4700::1111'], found: ['2606:4700::1111'], ok: true },
] };
function harness(hostname, protocol = 'http:', initial = {}, summary = false) {
  const hooks = []; const effects = []; let index = 0;
  const calls = []; const timers = new Map(); let nextTimer = 1;
  const failures = new Map();
  let panelMode = initial.panelMode || 'all'; let startedAtMs = 1; let settings = initial.settings || {}; let startupSettings = initial.startupSettings || {}; let running = true; let jobStatus = 'done'; let held = null; let release;
  let currentDomain = initial.domain || domainStatus;
  const copied = [];
  let clipboardFields = 0;
  const globalsClipboard = initial.clipboardFallback ? {
    navigator: { clipboard: { writeText: async () => { throw new Error('Denied'); } } },
    HTMLElement: class {},
    document: {
      body: { appendChild() { clipboardFields++; } },
      createElement() { return {
        setAttribute() {}, select() { copied.push(this.value); }, remove() { clipboardFields--; },
      }; },
      execCommand: () => initial.clipboardFallback === 'success',
    },
  } : { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } };
  const react = {
    useState: (initial) => { const slot = index++; if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], (value) => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
    useRef: (initial) => { const slot = index++; return hooks[slot] ??= { current: initial }; },
    useCallback: (fn, deps) => { const slot = index++; if (!hooks[slot] || deps.some((v, i) => v !== hooks[slot].deps[i])) hooks[slot] = { fn, deps }; return hooks[slot].fn; },
    useEffect: (fn, deps) => { const slot = index++; if (!hooks[slot] || deps.some((v, i) => v !== hooks[slot].deps[i])) {
      hooks[slot]?.cleanup?.(); hooks[slot] = { deps }; effects.push(() => { hooks[slot].cleanup = fn(); });
    } },
  };
  const listen = () => ({ startedAtMs, panel: { mode: panelMode, port: 3740, addresses: [] }, agents: { mode: 'local', differing: 1, stoppedDiffering: 2, runningDiffering: running ? [{ id: 'running-agent', name: 'Running agent' }] : [] } });
  const globals = {
    AbortController, window: { location: { hostname, protocol, port: '3740' } },
    ...globalsClipboard,
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const failure = failures.get(`${options.method || 'GET'} ${url}`);
      if (failure) return { ok: false, status: failure.status || 500, json: async () => ({ error: failure.message || failure }) };
      if (held === url && (url.startsWith('/api/domain/') || options.method === 'PUT')) {
        await new Promise((resolve) => { release = resolve; });
      }
      let body;
      if (url === '/api/system/listen') body = listen();
      else if (url === '/api/system/remote-access' && options.method === 'PUT') { settings = JSON.parse(options.body).edits; body = { status: 'ok' }; }
      else if (url === '/api/system/remote-access') body = { settings, startupSettings };
      else if (url === '/api/config/restart') { panelMode = settings.REV4A_LISTEN; body = { status: 'ok', restarting: true, mode: 'supervisor' }; }
      else if (url === '/api/domain/status') body = currentDomain;
      else if (url === domainDnsUrl) body = dnsResult;
      else if (url === '/api/domain/credential') body = { user: 'rev4a', password: samplePassword };
      else if (url.endsWith('/recreate')) body = options.method === 'POST' ? { id: 7, started: true } : { recreate: { id: 7, status: jobStatus } };
      else assert.fail(url);
      return { ok: true, json: async () => body };
    },
  };
  const cache = {};
  function localLoad(file) {
    if (cache[file]) return cache[file];
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const dependencies = { react, 'react/jsx-runtime': require('react/jsx-runtime'), '@/lib/remote-access': access,
      '@/lib/domain-name': require('../lib/domain-name.js'),
      'next/link': { default: function Link() {} } };
    for (const [, name] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      if (name in dependencies) continue;
      if (name.endsWith('/components/ui')) dependencies[name] = { ...ui, ...localLoad('app/components/ui/DataTable.tsx') };
      else if (name.endsWith('/components/Skeleton')) dependencies[name] = { SkeletonLines: function SkeletonLines() {} };
      else if (name.endsWith('/components/Icons')) dependencies[name] = Object.fromEntries(['GlobeIcon', 'MonitorIcon', 'ShieldIcon'].map((key) => [key, function Icon() {}]));
      else if (name.startsWith('.')) {
        const base = path.join(path.dirname(file), name);
        dependencies[name] = localLoad(fs.existsSync(path.join(root, base + '.tsx')) ? base + '.tsx' : base + '.ts');
      }
    }
    return cache[file] = load(file, dependencies, globals);
  }
  const client = localLoad(summary ? 'app/system/RemoteAccessSummary.tsx' : 'app/remote-access/PageClient.tsx');
  function render() {
    index = 0; const nodes = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        nodes.push(node);
        if (typeof node.type === 'function' && !Object.values(ui).includes(node.type)) return walk(node.type(node.props));
        walk(node.props?.children);
        walk(node.props?.badge);
        if (node.type === ui.ItemList) for (const item of node.props.items) { walk(item.content); walk(item.action); }
        if (node.type === ui.PropertyList) for (const row of node.props.rows) { walk(row.label); walk(row.value); }
      }
    };
    walk(summary ? client.RemoteAccessSummary() : client.default()); effects.splice(0).forEach((fn) => fn()); return nodes;
  }
  const button = (text) => render().find((node) => node.type === ui.Button && node.props.children === text);
  return { render, calls, button, copied, clipboardFields: () => clipboardFields, setDomain: (next) => { currentDomain = next; },
    hold: (url) => { held = url; }, release: () => { held = null; release(); },
    fail: (url, message, method = 'GET') => { if (message) failures.set(`${method} ${url}`, message); else failures.delete(`${method} ${url}`); },
    option: (id) => render().find((node) => node.type === ui.TemplateOption && node.props.id === id),
    modal: () => render().find((node) => node.type === ui.Modal),
    restartBoot: () => { startedAtMs++; startupSettings = { ...settings }; },
    setRunning: (value) => { running = value; }, setJob: (value) => { jobStatus = value; },
    pollJob: async () => { const [id, timer] = [...timers].find(([, timer]) => timer.delay === 2000); timers.delete(id); await timer.fn(); },
    timeoutRestart: () => { const [id, timer] = [...timers].find(([, timer]) => timer.delay === 60000); timers.delete(id); timer.fn(); },
    poll: async () => { const [id, timer] = [...timers].find(([, timer]) => timer.delay === 10000); timers.delete(id); await timer.fn(); },
    dispose: () => { for (const hook of hooks) hook?.cleanup?.(); } };
}
for (const hostname of ['localhost', 'localhost.', '127.0.0.1', '127.0.0.2', '[::1]', '192.168.1.5', 'panel.example.com']) {
  const h = harness(hostname); h.render(); await flush();
  assert.equal(h.option('This computer only').props.disabled, !access.presetGuard('local', { hostname, protocol: 'http:' }).allowed);
  assert.ok(h.calls.every((call) => !call.options.method), 'mount never applies, restarts or recreates');
  const system = harness(hostname, 'http:', {}, true);
  system.render(); await flush();
  assert.equal(system.render().some((node) => node.type === 'span' && node.props.children === 'Rev4a is also reachable from your network.'), access.isLoopbackHost(hostname));
  assert.ok(system.render().some((node) => node.props?.href === '/remote-access' && node.props.children === 'Manage'));
  assert.equal(system.render().some((node) => node.type === ui.TemplateOption), false);
  system.dispose();
  h.dispose();
}
console.log('ok   Page loopback guards, System LAN notice with Manage link and read-only mount');
for (const [hostname, protocol, needsConfirm] of [['192.168.1.5', 'http:', true], ['[2001:db8::1]', 'https:', true], ['panel.example.com', 'https:', true]]) {
  const h = harness(hostname, protocol); h.render(); await flush();
  h.option('Domain (your own proxy)').props.onClick();
  assert.equal(h.modal().props.open, true);
  assert.equal(h.button('Apply').props.disabled, needsConfirm);
  assert.ok(h.render().some((node) => node.type === 'code' && JSON.stringify(node.props.children).includes('127.0.0.1:')));
  if (needsConfirm) h.render().find((node) => node.type === ui.Switch).props.onChange(true);
  assert.equal(h.button('Apply').props.disabled, false);
  h.hold('/api/system/remote-access'); h.button('Apply').props.onClick();
  h.button('Applying…').props.onClick(); // A repeated event cannot submit twice.
  assert.equal(h.calls.filter((call) => call.options.method === 'PUT').length, 1);
  assert.equal(h.button('Applying…').props.loading, true);
  assert.ok(h.render().filter((node) => node.type === ui.TemplateOption).every((node) => node.props.disabled));
  h.release(); await flush();
  assert.equal(h.modal().props.open, false);
  assert.ok(h.button('Restart now'));
  assert.equal(h.calls.filter((call) => call.url.endsWith('/recreate')).length, 0);
  assert.equal(h.button('Recreate'), undefined, 'pending panel restart hides recreate actions');
  h.button('Restart now').props.onClick(); await flush();
  assert.equal(h.button('Recreate'), undefined, 'restart must be observed before enabling recreate');
  assert.equal(h.button('Restarting…').props.loading, true);
  h.restartBoot(); await h.poll(); h.render();
  assert.ok(h.button('Recreate'), 'a new server start unlocks explicit recreate');
  h.dispose();
}
console.log('ok   Domain acknowledgement, exact confirm/apply, keyed loading and no automatic recreate');
const h = harness('localhost'); h.render(); await flush();
assert.ok(h.render().some((node) => node.type === ui.Pill && JSON.stringify(node.props.children).includes('Different address → this host')));
assert.equal(h.render().filter((node) => node.type === ui.Button && node.props.children === 'Recreate').length, 1, 'only running ids get buttons; stopped count has none');
assert.ok(h.render().some((node) => node.type === 'p' && node.props.children?.join?.('') === '2 stopped agents will ask before starting'));
h.button('Recreate').props.onClick(); await flush(); h.render(); await flush();
assert.equal(h.calls.filter((call) => call.url.endsWith('/recreate') && call.options.method === 'POST').length, 1);
assert.equal(h.calls.filter((call) => call.url.endsWith('/recreate') && !call.options.method).length, 1, 'polls the job after the explicit click');
h.dispose();
console.log('ok   Only the running mismatch gets Recreate; one click posts once and polls its job');
const domain = access.presetEdits('domain', {});
const sameBoot = harness('panel.example.com', 'https:', { panelMode: 'local', settings: domain, startupSettings: access.presetEdits('local', {}) });
sameBoot.render(); await flush();
assert.ok(sameBoot.button('Restart now'));
assert.equal(sameBoot.option('Domain (your own proxy)').props.selected, false);
console.log('SAVED_DOMAIN_SAME_BOOT restartButton true domainSelected false');
sameBoot.dispose();
for (const status of ['backing_up', 'recreating', 'verifying']) {
  const job = harness('localhost'); job.setJob(status); job.render(); await flush();
  job.button('Recreate').props.onClick(); await flush(); job.render(); await flush();
  assert.equal(job.button('Recreating…').props.loading, true);
  console.log(`JOB_${status.toUpperCase()}_BEFORE_REFRESH recreatingButton true`);
  job.setRunning(false); await job.poll(); job.render();
  assert.equal(job.button('Recreating…').props.loading, true);
  assert.ok(job.render().filter((node) => node.type === ui.TemplateOption).every((node) => node.props.disabled));
  console.log(`JOB_${status.toUpperCase()}_AFTER_REFRESH recreatingButton true disabledChoices true`);
  job.setJob('done'); await job.pollJob(); job.render();
  assert.equal(job.button('Recreating…'), undefined);
  assert.ok(job.render().filter((node) => node.type === ui.TemplateOption).every((node) => !node.props.disabled));
  job.dispose();
}
for (const status of ['failed', 'interrupted']) {
  const job = harness('localhost'); job.setJob('backing_up'); job.render(); await flush();
  job.button('Recreate').props.onClick(); await flush(); job.render(); await flush();
  job.setJob(status); await job.pollJob(); job.render();
  assert.equal(job.button('Recreating…'), undefined);
  assert.ok(job.render().some((node) => node.props?.role === 'alert'));
  console.log(`JOB_TERMINAL_${status.toUpperCase()} loading false errorShown true`);
  job.dispose();
}
const timeout = harness('localhost', 'http:', { settings: access.presetEdits('local', {}) });
timeout.render(); await flush(); timeout.button('Restart now').props.onClick(); await flush();
assert.equal(timeout.button('Restarting…').props.loading, true);
timeout.timeoutRestart();
assert.ok(timeout.button('Restart now')); assert.equal(timeout.button('Restart now').props.disabled, false);
console.log('RESTART_TIMEOUT_60000 retry true loading false'); timeout.dispose();
for (const retry of [false, true]) {
  const late = harness('localhost', 'http:', { settings: access.presetEdits('local', {}) });
  late.render(); await flush(); late.button('Restart now').props.onClick(); await flush();
  late.button('Restarting…'); late.timeoutRestart();
  assert.ok(late.render().some((node) => node.props?.role === 'alert' && node.props.children.includes('not been confirmed')));
  await late.poll(); late.render();
  assert.equal(late.button('Recreate'), undefined, 'the same boot after timeout must not enable Recreate');
  assert.ok(late.button('Restart now'));
  if (retry) {
    late.button('Restart now').props.onClick(); await flush();
    assert.equal(late.button('Restarting…').props.loading, true);
    late.timeoutRestart();
    assert.equal(late.button('Restart now').props.disabled, false, 'retry also has a 60-second deadline');
  }
  late.fail('/api/system/listen', 'temporary restart 503');
  await late.poll(); late.render();
  late.fail('/api/system/listen', null); late.restartBoot(); await late.poll(); late.render();
  assert.ok(late.button('Recreate'), 'a late new boot enables the running-agent rows');
  assert.equal(late.button('Restart now'), undefined, 'late recovery clears the obsolete pending state');
  assert.equal(late.render().some((node) => node.props?.role === 'alert'), false, 'late recovery clears timeout and read errors');
  late.dispose();
}
console.log('ok   Late restart recovery clears timeout/pending state and enables Recreate, including after retry');
const lateApply = harness('localhost', 'http:', { settings: access.presetEdits('local', {}) });
lateApply.render(); await flush(); lateApply.button('Restart now').props.onClick(); await flush();
lateApply.button('Restarting…'); lateApply.timeoutRestart(); lateApply.render();
lateApply.option('Direct (IP)').props.onClick(); lateApply.hold('/api/system/remote-access');
lateApply.button('Apply').props.onClick(); await flush();
lateApply.restartBoot(); await lateApply.poll(); lateApply.render();
assert.equal(lateApply.button('Applying…').props.loading, true, 'late boot confirmation must retain a newer action lock');
lateApply.button('Applying…').props.onClick();
assert.equal(lateApply.calls.filter((call) => call.options.method === 'PUT').length, 1);
lateApply.release(); await flush();
assert.ok(lateApply.button('Restart now'), 'the newer saved settings still need their own restart');
lateApply.dispose();
console.log('ok   Late boot confirmation preserves a newer Apply action and its restart requirement');
for (const url of ['/api/system/listen', '/api/system/remote-access']) {
  const recovered = harness('localhost', 'http:', {}, true);
  recovered.fail(url, 'temporary 503'); recovered.render(); await flush();
  const shows = (text) => recovered.render().some((node) => node.props?.children === text);
  assert.ok(shows('Access status unavailable.'));
  recovered.fail(url, null); await recovered.poll();
  assert.ok(shows('Rev4a is also reachable from your network.'));
  assert.equal(shows('Access status unavailable.'), false);
  recovered.dispose();
}
const failedAction = harness('localhost'); failedAction.render(); await flush();
failedAction.option('This computer only').props.onClick();
failedAction.fail('/api/system/remote-access', 'preset save refused', 'PUT');
failedAction.button('Apply').props.onClick(); await flush(); await failedAction.poll();
assert.ok(failedAction.render().some((node) => node.props?.role === 'alert' && node.props.children === 'preset save refused'), 'successful reads preserve action failures');
failedAction.fail('/api/system/listen', 'temporary 503'); await failedAction.poll();
failedAction.fail('/api/system/listen', null); await failedAction.poll();
assert.ok(failedAction.render().some((node) => node.props?.role === 'alert' && node.props.children === 'preset save refused'), 'read failure and recovery never overwrite an action error');
failedAction.dispose();
console.log('ok   Recovered reads restore System LAN notice and retain independent action errors');
const current = harness('localhost', 'http:', { panelMode: 'local', settings: domain, startupSettings: domain });
current.render(); await flush();
assert.equal(current.option('Domain (your own proxy)').props.disabled, true);
assert.ok(current.render().some((node) => node.type === ui.Pill && node.props.children === 'Current'));
// Even an already-open confirmation whose saved values match cannot submit again.
current.option('Domain (your own proxy)').props.onClick();
assert.equal(current.button('Already applied').props.disabled, true);
current.button('Already applied').props.onClick(); await flush();
assert.equal(current.calls.filter((call) => call.options.method === 'PUT').length, 0);
assert.ok(current.render().some((node) => node.type === ui.PropertyList));
assert.ok(current.render().some((node) => node.type === ui.Switch));
current.dispose();
const TemplateOption = load('app/components/ui/TemplateOption.tsx', { 'react/jsx-runtime': require('react/jsx-runtime') }).TemplateOption;
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
function avatarStyle(selected, variant) {
  const option = TemplateOption({ id: 'Atlas', selected, description: 'Agent template', onClick() {}, ...(variant ? { avatarVariant: variant, icon: 'icon' } : {}) });
  const avatar = option.props.children[0];
  assert.equal(option.props.style, undefined);
  const style = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rule = selector.trim();
    if (!rule.startsWith('.ui-template-option') || !rule.includes('__avatar')) continue;
    if (rule.includes('--selected') && !option.props.className.includes('--selected')) continue;
    if (rule.includes('__avatar--icon') && !avatar.props.className.includes('__avatar--icon')) continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return { style, content: avatar.props.children };
}
for (const selected of [false, true]) {
  const legacy = avatarStyle(selected);
  assert.equal(legacy.content, 'A');
  assert.deepEqual(legacy.style, { width: '28px', height: '28px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
    'border-radius': '50%', background: selected ? 'var(--violet)' : 'var(--border)', color: selected ? '#111' : '#666', 'font-size': '12px', 'font-weight': '600', 'flex-shrink': '0' });
  const icon = avatarStyle(selected, 'icon');
  assert.equal(icon.content, 'icon'); assert.equal(icon.style['border-radius'], '0');
  assert.equal(icon.style.color, selected ? 'var(--bg)' : 'var(--text-dim)');
}
assert.equal(h.option('This computer only').props.avatarVariant, 'icon');
const wizardOptions = load('app/wizard/AccessStep.tsx', {
  react: { useEffect() {}, useState: (value) => [value, () => {}] }, 'react/jsx-runtime': require('react/jsx-runtime'),
  '../components/ui': ui, '../remote-access/PresetOption': load('app/remote-access/PresetOption.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'), '../components/ui': ui, '../components/Icons': { GlobeIcon() {}, MonitorIcon() {}, ShieldIcon() {} },
  }), '@/lib/remote-access': access,
}).AccessStep({ onNext() {}, onSkip() {}, localChosen: false, onChoice() {} });
for (const option of wizardOptions.props.children.filter((node) => typeof node?.type === 'function' && node.props.preset)) {
  assert.equal(option.type(option.props).props.avatarVariant, 'icon');
}
console.log('ok   Legacy TemplateOption avatar preserves round shape, weight and colors; access page/wizard opt into icon styling');
const wizardFile = 'app/wizard/PageClient.tsx';
const wizardSource = fs.readFileSync(path.join(root, wizardFile), 'utf8');
const doneStepSource = ts.createSourceFile(wizardFile, wizardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  .statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'DoneStep').getText();
const DoneStep = load(wizardFile, { 'react/jsx-runtime': require('react/jsx-runtime') }, {
  Link: function Link() {}, CheckCircleIcon() {}, CheckIcon() {}, ArrowRightIcon() {}, Button: ui.Button, Surface: ui.Surface,
}, doneStepSource + '\nexport { DoneStep };').DoneStep;
const done = DoneStep({ onComplete() {}, onRestart() {}, accessRestart: true, manualRestart: false, action: null, error: '' });
const instruction = done.props.children.find((node) => node?.type === 'p' && Array.isArray(node.props.children) && node.props.children[0]?.includes('Existing agents'));
assert.ok(instruction, 'local choice renders the recreate instruction');
assert.ok(instruction.props.children.some((node) => node?.props?.href === '/remote-access' && node.props.children === 'Remote access'));
assert.ok(!JSON.stringify(instruction.props.children).includes('from System'));
for (const file of ['README.md', 'CONNECT.md']) {
  const note = fs.readFileSync(path.join(root, file), 'utf8').split('\n').find((line) => line.startsWith('**1.29.0:**'));
  assert.match(note, /\*\*Remote access\*\* page/);
  assert.ok(note.includes('`/remote-access`'));
  assert.match(note, /\]\(https:\/\/rev4a\.app\/en\/docs\/remote-access\)/);
  assert.doesNotMatch(note, /presets in System/);
}
console.log('ok   Wizard completion and README/CONNECT direct operators to /remote-access');
assert.match(fs.readFileSync(path.join(root, 'app/remote-access/page.tsx'), 'utf8'), /title: 'Remote access'/);
const sidebar = fs.readFileSync(path.join(root, 'app/components/Sidebar.tsx'), 'utf8');
assert.match(sidebar, /href: '\/remote-access',[\s\S]*?href: '\/config'/);
const systemSource = fs.readFileSync(path.join(root, 'app/system/PageClient.tsx'), 'utf8');
assert.ok(systemSource.indexOf('<RemoteAccessSummary />') > systemSource.indexOf('className="system-charts"'), 'access summary follows host metrics and charts');
assert.doesNotMatch(systemSource, /RemoteAccessSection/);
console.log('ok   Current preset is inert, unchanged edits cannot submit, page title and sidebar route, compact System placement');

{
  const h = harness('localhost');
  const input = () => h.render().find((node) => node.type === ui.Input && node.props.label === 'Dashboard domain');
  const text = (value) => h.render().some((node) => node.props?.children === value);
  h.render();
  assert.equal(h.button('Checking…').props.loading, true);
  await flush();
  assert.ok(input());
  assert.equal(h.button('Copy dry run').props.disabled, true);
  assert.equal(h.button('Copy setup command').props.disabled, true);
  assert.equal(h.calls.filter(({ url }) => url.startsWith('/api/domain/dns?')).length, 0);
  input().props.onChange({ target: { value: 'https://rev4a.example.com' } });
  assert.ok(input().props.error);
  input().props.onChange({ target: { value: ' REV4A.EXAMPLE.COM ' } });
  assert.ok(!input().props.error);
  assert.equal(h.button('Copy setup command').props.disabled, false);
  assert.ok(text(domainHost) && text(`*.${domainHost}`) && text('1.1.1.1') && text('2606:4700::1111'));
  h.button('Copy dry run').props.onClick();
  await flush();
  h.button('Copy setup command').props.onClick();
  await flush();
  assert.deepEqual(h.copied, [`sudo rev4a domain setup ${domainHost} --dry-run`, `sudo rev4a domain setup ${domainHost}`]);
  h.hold(domainDnsUrl);
  h.button('Check').props.onClick();
  await flush();
  assert.equal(h.button('Checking…').props.loading, true);
  assert.equal(h.button('Copy setup command').props.disabled, true);
  assert.deepEqual(h.calls.slice(-2).map(({ url }) => url), ['/api/domain/status', domainDnsUrl]);
  const dnsRequest = h.calls.at(-1);
  input().props.onChange({ target: { value: 'other.example.com' } });
  assert.equal(dnsRequest.options.signal.aborted, true);
  h.release();
  await flush();
  assert.ok(!text('1.1.1.3'), 'an aborted DNS result cannot populate another hostname');
  input().props.onChange({ target: { value: domainHost } });
  h.button('Check').props.onClick();
  await flush();
  for (const value of ['OK', 'Missing', 'Wrong', '1.1.1.2', '1.1.1.3']) assert.ok(text(value), value);
  h.setDomain({ ...activeDomain, enabled: false, restartPending: true });
  h.button('Check').props.onClick();
  await flush();
  assert.ok(input());
  assert.ok(text('Restart Rev4a to load the saved Domain settings, then check again.'));
  h.setDomain(activeDomain);
  h.button('Check').props.onClick();
  await flush();
  assert.equal(input(), undefined);
  assert.ok(h.render().some((node) => node.props?.href === `https://${domainHost}` && node.props.className === 'ui-link'));
  const rows = h.render().find((node) => node.type === ui.PropertyList && node.props.rows.some((row) => row.label === 'Caddy installed')).props.rows;
  for (const label of ['Agent routes', 'Restart pending', 'Dev-port credential']) assert.ok(rows.some((row) => row.label === label));
  assert.equal(rows.find((row) => row.label === 'Agent routes').value, 4);
  const explanation = h.render().find(node => Array.isArray(node.props?.children)
    && node.props.children.some(part => typeof part === 'string' && part.includes('Managed HTTPS dev-port names')));
  assert.ok(explanation);
  assert.match(explanation.props.children.filter(part => typeof part === 'string').join(''), /Basic authentication.*Direct host-port access.*Recreate makes the agent ports loopback only/);
  assert.ok(explanation.props.children.some(part => part?.props?.children === 'REV4A_AGENT_PORTS_LISTEN'));
  assert.ok(text('••••••••'));
  assert.ok(!text(samplePassword));
  assert.ok(!h.calls.some(({ url }) => url === '/api/domain/credential'));
  h.fail('/api/domain/credential', { status: 404, message: 'Fixture unavailable' });
  h.button('Show').props.onClick();
  await flush();
  assert.ok(h.render().some((node) => node.props?.role === 'alert' && node.props.children.includes('No dev-port credential')));
  h.fail('/api/domain/credential', null);
  h.hold('/api/domain/credential');
  h.button('Show').props.onClick();
  assert.equal(h.button('Showing…').props.loading, true);
  assert.ok(!text(samplePassword));
  assert.equal(h.calls.at(-1).options.referrerPolicy, 'no-referrer');
  h.release();
  await flush();
  assert.ok(text(samplePassword));
  h.button('Copy').props.onClick();
  await flush();
  assert.equal(h.copied.at(-1), samplePassword);
  h.button('Hide').props.onClick();
  assert.ok(text('••••••••'));
  assert.ok(!text(samplePassword));
  h.hold('/api/domain/credential');
  h.button('Show').props.onClick();
  const credentialRequest = h.calls.at(-1);
  h.dispose();
  assert.equal(credentialRequest.options.signal.aborted, true);
  h.release();
  await flush();
}
{
  const h = harness('localhost', 'http:', { domain: { ...domainStatus, serverAddresses: { ipv4: [], ipv6: [] } } });
  h.fail('/api/domain/status', 'Status fixture unavailable');
  h.render();
  await flush();
  assert.ok(h.render().some((node) => node.props?.role === 'alert' && node.props.children === 'Status fixture unavailable'));
  h.fail('/api/domain/status', null);
  h.button('Check').props.onClick();
  await flush();
  const input = h.render().find((node) => node.type === ui.Input);
  input.props.onChange({ target: { value: domainHost } });
  assert.ok(h.render().some((node) => typeof node.props?.children === 'string' && node.props.children.includes('Use the server’s public IP')));
  h.dispose();
}
console.log('ok   Domain wizard, DNS mismatch states and aborts, status transition, credential reveal only on Show and clipboard feedback');

{
  const localSettings = { REV4A_LISTEN: 'local', REV4A_AGENT_PORTS_LISTEN: 'local', REV4A_TRUSTED_PROXIES: '127.0.0.1,::1' };
  const h = harness(domainHost, 'https:', { domain: activeDomain, panelMode: 'local', settings: localSettings, startupSettings: localSettings });
  h.render();
  await flush();
  const text = (value) => h.render().some((node) => node.props?.children === value);
  assert.ok(text('Domain (Caddy, managed by Rev4a)'));
  assert.equal(h.option('Domain (your own proxy)').props.current, false);
  assert.match(h.option('Domain (your own proxy)').props.description, /nginx, Traefik, or Tailscale serve/);
  assert.equal(h.calls.filter(({ url }) => url === domainDnsUrl).length, 1);
  assert.equal(h.render().filter((node) => node.type === ui.Button && /^Check/.test(node.props.children)).length, 1);
  assert.ok(h.render().some(({ type, props }) => type === 'table' && props['aria-label'] === 'Required DNS records'));
  assert.ok(!text('Not checked'));
  assert.equal(h.calls.filter(({ url }) => url === '/api/domain/credential').length, 0);
  h.setDomain({ ...activeDomain, port: 7000, dataDir: '/service/rev4a',
    caddy: { ...activeDomain.caddy, onDemandAsk: false, askTarget: 'stale' } });
  h.button('Check').props.onClick();
  await flush();
  assert.equal(h.calls.filter(({ url }) => url === domainDnsUrl).length, 2);
  assert.ok(text('Caddy points to an old Rev4a address: run the setup command again.'));
  assert.ok(!text('Restart Rev4a to load the saved Domain settings, then check again.'));
  h.button('Copy setup command').props.onClick();
  await flush();
  assert.deepEqual(h.copied, [`sudo PORT=7000 REV4A_DATA_DIR=/service/rev4a rev4a domain setup ${domainHost}`]);
  h.dispose();
  console.log('ok   Managed Mode pill; own-proxy preset Current=false; one DNS check on open; Check refreshes both; stale callback shows setup without a restart instruction');
}

for (const [dataDir, fallback] of [['/service/rev4a', 'success'], ["/service/Rev4a's \$HOME", 'failure']]) {
  const h = harness('localhost', 'http:', { domain: { ...domainStatus, port: 8080, dataDir }, clipboardFallback: fallback });
  h.render();
  await flush();
  h.render().find((node) => node.type === ui.Input).props.onChange({ target: { value: domainHost } });
  for (const label of ['Copy dry run', 'Copy setup command']) {
    h.button(label).props.onClick();
    await flush();
    assert.equal(h.clipboardFields(), 0, 'temporary field removed on clipboard success and failure');
  }
  for (const [index, command] of h.copied.entries()) {
    // Capture only argument parsing. Neither sudo nor the Rev4a launcher runs.
    const received = execFileSync('sh', ['-c', `sudo() { printf '%s\\n' "$@"; }\n${command}`], { encoding: 'utf8' }).trimEnd().split('\n');
    assert.deepEqual(received, ['PORT=8080', `REV4A_DATA_DIR=${dataDir}`, 'rev4a', 'domain', 'setup', domainHost,
      ...(index === 0 ? ['--dry-run'] : [])]);
  }
  assert.equal(h.copied.length, 2);
  console.log(`ok   Copied dry run and setup: shell receives PORT=8080 and REV4A_DATA_DIR=${dataDir}; clipboard fallback ${fallback} cleans up`);
  h.dispose();
}
console.log('\nRemote access UI checks passed');
