#!/usr/bin/env node
/** Offline pairing SDK/legacy command and route integration tests. No Docker or network. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { buildPairingStoreScript, parsePairingStoreOutput } = require('../lib/channel-pairing-store.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-pairing-'));
let fixtureCount = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exitCode = 1; throw e; }
}

function fixture({ sdk, legacy, entries = ['111', '222'], exported = true } = {}) {
  const root = path.join(dir, String(++fixtureCount), 'node_modules', 'openclaw');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'openclaw', type: 'module',
    exports: exported ? { './plugin-sdk/channel-pairing': './public-sdk.mjs' } : {},
  }));
  if (sdk !== undefined) fs.writeFileSync(path.join(root, 'public-sdk.mjs'), sdk);
  if (legacy !== undefined) fs.writeFileSync(path.join(root, 'dist', 'pairing-store-fixture.mjs'), legacy);
  fs.writeFileSync(path.join(root, 'entries.json'), JSON.stringify(entries));
  return root;
}
const state = `import fs from 'node:fs';
const file = new URL('../entries.json', import.meta.url);
const list = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (entries) => fs.writeFileSync(file, JSON.stringify(entries));`;
const reader = `export async function readChannelAllowFromStore(channel) {
  if (channel !== 'telegram') throw new Error('Wrong SDK arguments');
  return ['111', '222'];
}`;
const legacyReader = `${state}
export function readChannelAllowFromStoreSync(channel) {
  if (channel !== 'telegram') throw new Error('Wrong legacy arguments'); return list();
}`;
const remover = `${state}
export async function removeChannelAllowFromStoreEntry({ channel, entry }) {
  if (channel !== 'telegram') throw new Error('Wrong removal arguments');
  const before = list(); const after = before.filter(value => value !== entry); save(after);
  return { changed: after.length !== before.length, allowFrom: after };
}`;
function run(root, op = 'read', entry, timeout = 3000) {
  const args = ['-e', buildPairingStoreScript(root), op, 'telegram'];
  if (entry !== undefined) args.push(entry);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout });
  return { ...result, parsed: parsePairingStoreOutput(result.stdout ?? '', op) };
}

// Exercise actual self-package export resolution from a Node process outside the
// fake global package, rather than importing a known fixture file directly.
try {
  await test('public async package export reads without any private remover', () => {
    const result = run(fixture({ sdk: reader }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.parsed, { status: 'ok', entries: ['111', '222'] });
  });
  await test('public read never imports a broken private module', () => {
    const result = run(fixture({ sdk: reader, legacy: "throw new Error('private module must not load');" }));
    assert.equal(result.parsed.status, 'ok');
  });
  await test('legacy sync reader works when the package does not export the SDK', () => {
    assert.deepEqual(run(fixture({ exported: false, legacy: legacyReader })).parsed,
      { status: 'ok', entries: ['111', '222'] });
  });
  await test('legacy reader works without a remover', () => {
    assert.equal(run(fixture({ exported: false, legacy: legacyReader, entries: [] })).parsed.status, 'ok');
  });
  await test('missing public function can use the legacy reader', () => {
    assert.equal(run(fixture({ sdk: 'export const unrelated = true;', legacy: legacyReader })).parsed.status, 'ok');
  });
  await test('a broken public SDK is an error, not a silent legacy fallback', () => {
    const result = run(fixture({ sdk: "throw new Error('sensitive-native-detail');", legacy: legacyReader }));
    assert.equal(result.parsed.status, 'error');
    assert.ok(!result.stdout.includes('sensitive-native-detail'));
  });
  await test('a failing async reader reports a safe error', () => {
    const result = run(fixture({ sdk: "export async function readChannelAllowFromStore() { throw new Error('sensitive-native-detail'); }" }));
    assert.equal(result.parsed.status, 'error');
    assert.ok(!result.stdout.includes('sensitive-native-detail'));
  });
  await test('unknown capabilities are explicitly unsupported', () => {
    assert.equal(run(fixture({ exported: false })).parsed.status, 'unsupported');
  });
  await test('remove does not require or import any reader', () => {
    const root = fixture({ sdk: "throw new Error('reader must not load');", legacy: remover });
    assert.equal(run(root, 'remove', '111').parsed.status, 'ok');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'entries.json'))), ['222']);
    assert.equal(run(root, 'remove', '111').parsed.status, 'absent');
  });
  await test('remove passes a shell-looking sender as a single literal argument', () => {
    const value = "a b; $(printf injected) ' quote";
    const root = fixture({ legacy: remover, entries: [value, 'keep'] });
    assert.equal(run(root, 'remove', value).parsed.status, 'ok');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'entries.json'))), ['keep']);
  });
  await test('unrecognized removal results cannot report already absent', () => {
    const root = fixture({ legacy: 'export async function removeChannelAllowFromStoreEntry() { return {}; }' });
    assert.equal(run(root, 'remove', '111').parsed.status, 'error');
  });
  await test('clear needs both capabilities even when the known list is empty', () => {
    const root = fixture({ sdk: reader, entries: [] });
    assert.equal(run(root, 'clear').parsed.status, 'unsupported');
  });
  await test('clear uses async SDK read with private removal and verifies empty result', () => {
    const root = fixture({ sdk: `import fs from 'node:fs';
export async function readChannelAllowFromStore() { return JSON.parse(fs.readFileSync(new URL('./entries.json', import.meta.url))); }`, legacy: remover });
    assert.equal(run(root, 'clear').parsed.status, 'ok');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'entries.json'))), []);
  });
  await test('clear retains the legacy read/remove path', () => {
    const root = fixture({ exported: false, legacy: `${legacyReader}
export async function removeChannelAllowFromStoreEntry({entry}) {
  const before = list(); const after = before.filter(value => value !== entry); save(after);
  return { changed: before.length !== after.length };
}` });
    assert.equal(run(root, 'clear').parsed.status, 'ok');
  });
  await test('clear failure after a successful first mutation does not return success', () => {
    const root = fixture({ exported: false, legacy: `${legacyReader}
export async function removeChannelAllowFromStoreEntry({entry}) {
  if (entry === '222') throw new Error('sensitive-native-detail');
  save(list().filter(value => value !== entry)); return { changed: true };
}` });
    const result = run(root, 'clear');
    assert.equal(result.parsed.status, 'error');
    assert.match(result.parsed.error, /some senders may already/);
    assert.ok(!result.stdout.includes('sensitive-native-detail'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'entries.json'))), ['222']);
  });
  await test('clear detects ineffective mutation from its final read', () => {
    const root = fixture({ exported: false, legacy: `${legacyReader}
export async function removeChannelAllowFromStoreEntry() { return { changed: false }; }` });
    assert.equal(run(root, 'clear').parsed.status, 'error');
  });
  await test('all entries are validated before clear can make its first write', () => {
    const root = fixture({ exported: false, entries: ['111', 5], legacy: `${legacyReader}
export async function removeChannelAllowFromStoreEntry() { save([]); return { changed: true }; }` });
    assert.equal(run(root, 'clear').parsed.status, 'error');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'entries.json'))), ['111', 5]);
  });
  await test('changed read envelope is an error instead of an invented empty list', () => {
    const root = fixture({ sdk: 'export async function readChannelAllowFromStore() { return { entries: [] }; }' });
    assert.equal(run(root).parsed.status, 'error');
  });
  await test('known object entry aliases are normalized without object stringification', () => {
    const root = fixture({ sdk: "export async function readChannelAllowFromStore() { return [{id:'1'},{senderId:'2'},{entry:'3'}]; }" });
    assert.deepEqual(run(root).parsed, { status: 'ok', entries: ['1', '2', '3'] });
  });
  await test('a killed/hung reader without a completion marker cannot pass', () => {
    const root = fixture({ sdk: 'export async function readChannelAllowFromStore() { setInterval(() => {}, 1000); return new Promise(() => {}); }' });
    const result = run(root, 'read', undefined, 150);
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.equal(result.parsed.status, 'error');
  });
  await test('terminal output is operation-specific, validated and unambiguous', () => {
    for (const output of ['', 'pair:ok', 'pair:absent', 'pair:list null', 'pair:list [1]', 'pair:list []\npair:error failed']) {
      assert.equal(parsePairingStoreOutput(output, 'read').status, 'error', output);
    }
    assert.equal(parsePairingStoreOutput('prefix pair:ok', 'remove').status, 'error');
    assert.equal(parsePairingStoreOutput('pair:absent', 'clear').status, 'error');
    assert.equal(parsePairingStoreOutput('noise\npair:list []\n', 'read').status, 'ok');
  });

  const source = fs.readFileSync(new URL('../lib/channelManager.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  function manager({ pending = '{"requests":[]}', store = 'pair:list ["111"]', config } = {}) {
    const calls = [];
    let writes = 0;
    const module = { exports: {} };
    const context = {
      module, exports: module.exports, console,
      require(spec) {
        if (spec === 'child_process') return { execSync(command) {
          if (command.startsWith('docker ps ')) return 'fixture-container';
          if (command.includes('cat /root/.openclaw/openclaw.json 2>/dev/null')) return JSON.stringify(config ?? {});
          if (command.startsWith('docker exec -i ')) { writes++; return ''; }
          throw new Error('Unexpected synchronous transport');
        } };
        if (spec === '@/lib/docker-exec') return {
          async dockerExec(_container, args, options) {
            calls.push({ args, options });
            if (args[0] === 'openclaw') { if (pending instanceof Error) throw pending; return pending; }
            if (store instanceof Error) throw store;
            return store;
          },
          async dockerExecShellNoFail() { throw new Error('Pending must not use no-fail shell transport'); },
        };
        if (spec === '@/lib/agent-config-lock') return { withAgentConfigLock: (_id, fn) => fn() };
        if (spec === '@/lib/channel-pairing-store') return require('../lib/channel-pairing-store.js');
        throw new Error(`Unexpected module ${spec}`);
      },
    };
    vm.runInNewContext(compiled, context);
    return { api: module.exports, calls, writes: () => writes };
  }
  const plain = value => JSON.parse(JSON.stringify(value));
  await test('getPairings keeps approved results when pending JSON is malformed', async () => {
    const m = manager({ pending: '{broken' });
    const result = plain(await m.api.getPairings('fixture'));
    assert.deepEqual(result.approved, [{ senderId: '111' }]);
    assert.deepEqual(result.pending, []);
    assert.match(result.error, /pending pairing requests/);
    assert.deepEqual(plain(m.calls[0].args), ['openclaw', 'pairing', 'list', '--channel', 'telegram', '--json']);
  });
  await test('valid pending requests preserve code/id aliases and nullable sender', async () => {
    const m = manager({ pending: '{"requests":[{"code":"ABCD","senderId":"222"},{"id":"EFGH"}]}' });
    const result = plain(await m.api.getPairings('fixture'));
    assert.deepEqual(result.pending, [{ code: 'ABCD', senderId: '222' }, { code: 'EFGH', senderId: null }]);
    assert.equal(result.error, null);
  });
  await test('empty, missing, partial or changed pending output remains an error', async () => {
    for (const pending of ['', '{}', '[]', '{"requests":{}}', '{"requests":[{"code":"ok"},null]}', '{"requests":[{"code":4}]}']) {
      const result = plain(await manager({ pending }).api.getPairings('fixture'));
      assert.deepEqual(result.pending, []);
      assert.match(result.error, /pending/);
      assert.equal(result.approved.length, 1);
    }
  });
  await test('pending transport failure does not disclose native stderr or lose approved entries', async () => {
    const result = plain(await manager({ pending: new Error('sensitive-native-detail') }).api.getPairings('fixture'));
    assert.match(result.error, /pending/);
    assert.equal(result.approved.length, 1);
    assert.ok(!JSON.stringify(result).includes('sensitive-native-detail'));
  });
  await test('pending success remains available when approved read is unsupported', async () => {
    const result = plain(await manager({ pending: '{"requests":[{"code":"ABCD"}]}', store: 'pair:unsupported' }).api.getPairings('fixture'));
    assert.equal(result.pending.length, 1);
    assert.match(result.error, /approved senders/);
  });
  await test('store transport failure/timeouts are explicit and sanitized', async () => {
    const result = plain(await manager({ store: new Error('sensitive-native-detail') }).api.revokePairing('fixture', '111'));
    assert.equal(result.success, false);
    assert.match(result.error, /failed or timed out/);
    assert.ok(!result.error.includes('sensitive-native-detail'));
  });
  await test('disconnect refuses config write after unsupported or partial clear', async () => {
    for (const store of ['pair:unsupported', 'pair:error Could not confirm the allowlist was cleared; some senders may already have been removed', '']) {
      const m = manager({ store, config: { channels: { telegram: { botToken: 'fixture-old', dmPolicy: 'pairing' } } } }); // secret-ok: synthetic offline fixture
      assert.equal((await m.api.removeTelegram('fixture')).success, false);
      assert.equal(m.writes(), 0);
    }
  });
  await test('bot rotation refuses config write after clear failure', async () => {
    const m = manager({ store: 'pair:unsupported', config: { channels: { telegram: { botToken: 'fixture-old', dmPolicy: 'pairing' } } } }); // secret-ok: synthetic offline fixture
    assert.equal((await m.api.setTelegramConfig('fixture', { botToken: 'fixture-new' })).success, false); // secret-ok: synthetic offline fixture
    assert.equal(m.writes(), 0);
  });
  await test('confirmed clear permits normal disconnect config write', async () => {
    const m = manager({ store: 'pair:ok', config: { channels: { telegram: { botToken: 'fixture-old' } } } }); // secret-ok: synthetic offline fixture
    assert.equal((await m.api.removeTelegram('fixture')).success, true);
    assert.equal(m.writes(), 1);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
