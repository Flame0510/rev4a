#!/usr/bin/env node
/** SEC-16: when Open warns, and that the client-side rule agrees with the server's controlUiHostFor. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, URL, URLSearchParams, Date,
    require: (id) => { if (Object.hasOwn(mocks, id)) return mocks[id]; throw new Error(`Unexpected dependency: ${id}`); } };
  vm.runInNewContext(source, context, { filename: file });
  return context.exports;
}
const navigation = load('lib/control-ui-navigation.ts', { './cron-ids': load('lib/cron-ids.ts') });
const devices = load('lib/agent-devices.ts', {
  '@/lib/docker-exec': {}, '@/lib/docker-socket': {}, '@/lib/container': {}, '@/lib/gateway-cli': {},
});
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok   ${name}`); };

const hosts = ['localhost', 'localhost.', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0',
  '192.168.1.10', '203.0.113.20', 'rev4a.lan', 'example.com', 'localhost.example.com', '127.999.1.1', '2001:db8::1'];

test('https never exposes, on any host', () => {
  for (const h of hosts) assert.equal(navigation.controlUiExposesSession('https:', h), false, h);
});

test('http exposes exactly the hosts controlUiHostFor does not isolate', () => {
  for (const h of hosts) {
    assert.equal(navigation.controlUiExposesSession('http:', h), !devices.controlUiHostFor(h).isolated, h);
  }
  for (const h of ['localhost', 'localhost.', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(navigation.controlUiExposesSession('http:', h), false, h);
  }
  for (const h of ['0.0.0.0', '192.168.1.10', '203.0.113.20', 'rev4a.lan', 'example.com']) {
    assert.equal(navigation.controlUiExposesSession('http:', h), true, h);
  }
});

test('other protocols never expose', () => {
  for (const p of ['', 'ftp:', 'file:', 'HTTP:']) assert.equal(navigation.controlUiExposesSession(p, '192.168.1.10'), false, p);
});

test('tunnel command writes IPv6 without brackets (OpenSSH user@host, zsh globs) and keeps user literal', () => {
  assert.equal(navigation.controlUiTunnelCommand('4550', '203.0.113.20'), 'ssh -L 4550:127.0.0.1:4550 user@203.0.113.20');
  assert.equal(navigation.controlUiTunnelCommand('4550', 'rev4a.lan'), 'ssh -L 4550:127.0.0.1:4550 user@rev4a.lan');
  assert.equal(navigation.controlUiTunnelCommand('4550', '2001:db8::1'), 'ssh -L 4550:127.0.0.1:4550 user@2001:db8::1');
  assert.equal(navigation.controlUiTunnelCommand('4550', '[2001:db8::1]'), 'ssh -L 4550:127.0.0.1:4550 user@2001:db8::1');
});

test('tunnel path adds tunnel=1, keeps a valid job and rejects an invalid one', () => {
  const job = '8d10c9bf-231a-41af-a01f-bdbb2ff6a3f1';
  assert.equal(navigation.controlUiTunnelPath('a1'), '/api/agents/a1/open-control-ui?tunnel=1');
  assert.equal(navigation.controlUiTunnelPath('a1', undefined, 'port'), '/api/agents/a1/open-control-ui?tunnel=port');
  assert.equal(navigation.controlUiTunnelPath('a1', job), `/api/agents/a1/open-control-ui?tunnel=1&job=${job}`);
  assert.throws(() => navigation.controlUiTunnelPath('a1', '../x'));
});

test('the Open button asks only through controlUiExposesSession and the modal is opt-in per click', () => {
  const src = fs.readFileSync(path.join(root, 'app/agents/BrowserAccessSection.tsx'), 'utf8');
  assert.match(src, /controlUiExposesSession\(window\.location\.protocol, window\.location\.hostname\)\) \{ setWarning\(true\)/);
  assert.match(src, /Plain HTTP: opens with a warning/);
  const modal = fs.readFileSync(path.join(root, 'app/agents/ControlUiExposureModal.tsx'), 'utf8');
  for (const text of ['Open the Control UI', 'Safe way: an SSH tunnel', 'Copy tunnel link', 'Open anyway', 'Cancel',
    'https://rev4a.app/en/docs/remote-access', 'noopener noreferrer']) assert.ok(modal.includes(text), text);
  assert.ok(!/localStorage|sessionStorage/.test(modal), 'nothing remembered');
});

console.log(`\n${passed} passed`);
