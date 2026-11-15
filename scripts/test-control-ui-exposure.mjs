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

// SEC-9B: Open when the agent's port is not reachable from this browser.
test('controlUiPortLocalOnly decision table', () => {
  const rows = [
    // [hostIp, dashboard host, local only?]
    [null, '203.0.113.20', false], [undefined, 'rev4a.lan', false], ['', 'rev4a.lan', false],
    ['0.0.0.0', '203.0.113.20', false], ['::', '203.0.113.20', false],
    ['127.0.0.1', '203.0.113.20', true], ['127.0.0.1', 'rev4a.example.com', true], ['::1', '203.0.113.20', true],
    ['127.0.0.1', '2001:db8::1', true], ['127.0.0.1', '[2001:db8::1]', true],
    ['127.0.0.1', 'localhost', false], ['127.0.0.1', '127.0.0.1', false], ['::1', '[::1]', false], ['127.0.0.1', '::1', false],
    ['10.0.0.5', '10.0.0.5', false], ['10.0.0.5', '203.0.113.20', true], ['10.0.0.5', 'rev4a.lan', false],
    ['2001:DB8::5', '[2001:db8::5]', false], ['2001:db8::5', '10.0.0.5', true], ['10.0.0.5', 'localhost', false],
  ];
  for (const [ip, host, expected] of rows) assert.equal(navigation.controlUiPortLocalOnly(ip, host), expected, `${ip} / ${host}`);
});

test('the tunnel command targets the port\'s own address only when it is a specific non-loopback IP', () => {
  const t = navigation.controlUiTunnelCommand;
  assert.equal(t('4550', 'srv.example.com'), 'ssh -L 4550:127.0.0.1:4550 user@srv.example.com');
  for (const ip of [null, undefined, '', '127.0.0.1', '0.0.0.0', '::']) assert.equal(t('4550', 'srv.example.com', ip), 'ssh -L 4550:127.0.0.1:4550 user@srv.example.com', String(ip));
  // An exact loopback address is the target as it is; ::1 is bracketed.
  assert.equal(t('4550', 'srv.example.com', '127.0.0.2'), 'ssh -L 4550:127.0.0.2:4550 user@srv.example.com');
  assert.equal(t('4550', 'srv.example.com', '::1'), "ssh -L '4550:[::1]:4550' user@srv.example.com");
  assert.equal(t('4550', 'srv.example.com', '[::1]'), "ssh -L '4550:[::1]:4550' user@srv.example.com");
  assert.equal(t('4550', 'srv.example.com', '10.0.0.5'), 'ssh -L 4550:10.0.0.5:4550 user@srv.example.com');
  assert.equal(t('4550', 'srv.example.com', '2001:db8::5'), "ssh -L '4550:[2001:db8::5]:4550' user@srv.example.com");
});

test('the local-only variant: https included, no "Open anyway", the agent list carries the HostIp and never a token', () => {
  const button = fs.readFileSync(path.join(root, 'app/agents/BrowserAccessSection.tsx'), 'utf8');
  assert.match(button, /controlUiPortLocalOnly\(hostIp, window\.location\.hostname\)\s*\|\|\s*controlUiExposesSession/);
  const modal = fs.readFileSync(path.join(root, 'app/agents/ControlUiExposureModal.tsx'), 'utf8');
  assert.ok(modal.includes("This agent&apos;s port is open only on the server itself. Use an SSH tunnel:"));
  assert.match(modal, /\{!localOnly && <Button variant="danger"[^>]*>Open anyway<\/Button>\}/);
  assert.ok(modal.includes('Copy tunnel link') && modal.includes('Remote access guide ↗'));
  const list = fs.readFileSync(path.join(root, 'app/api/agents/route.ts'), 'utf8');
  assert.match(list, /controlUiHostIp = port3000Binding\?\.\[0\]\?\.HostIp \|\| null/);
  assert.ok(!/token/i.test(list.slice(list.indexOf('controlUiHostIp'), list.indexOf('controlUiHostIp') + 120)));
  const page = fs.readFileSync(path.join(root, 'app/agents/PageClient.tsx'), 'utf8');
  assert.equal((page.match(/hostIp=\{agent\.controlUiHostIp\}/g) || []).length, 2, 'both Open buttons get the HostIp');
});

console.log(`\n${passed} passed`);
