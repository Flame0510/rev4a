import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const m = require('../lib/agent-packages.js');
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

test('parseStatus: the live example', () => {
  const s = m.parseStatus('{"at": 1791648030000, "state": "nothing-to-do", "restored": [], "versionChanged": [], "failed": []}');
  assert.deepEqual(s, { at: 1791648030000, state: 'nothing-to-do', restored: [], versionChanged: [], failed: [] });
});

test('parseStatus: all states known, others rejected', () => {
  for (const state of m.STATES) assert.equal(m.parseStatus(JSON.stringify({ at: 1, state }))?.state, state);
  for (const state of ['done', '', 5, null, 'OK']) assert.equal(m.parseStatus(JSON.stringify({ at: 1, state })), null);
});

test('parseStatus: not usable input', () => {
  for (const t of ['', 'nope', '[]', 'null', '5', '{"state":"ok"}', '{"at":"1","state":"ok"}', '{"at":-1,"state":"ok"}', undefined, null]) {
    assert.equal(m.parseStatus(t), null, String(t));
  }
});

test('parseStatus: arrays are filtered and capped', () => {
  const s = m.parseStatus(JSON.stringify({
    at: 5, state: 'partial',
    restored: ['a', 3, null, {}, '', 'b'],
    versionChanged: 'x',
    failed: [{ name: 'p', error: 'boom' }, { name: 'q' }, 'r', null, { name: 7, error: 'e' }, { name: 'z', error: 'line\nbreak' }],
  }));
  assert.deepEqual(s.restored, ['a', 'b']);
  assert.deepEqual(s.versionChanged, []);
  assert.deepEqual(s.failed, [{ name: 'p', error: 'boom' }, { name: 'z', error: 'line break' }]);
  const big = m.parseStatus(JSON.stringify({ at: 1, state: 'ok', restored: Array.from({ length: 900 }, (_, i) => `p${i}`), failed: [{ name: 'n'.repeat(500), error: 'e'.repeat(500) }] }));
  assert.equal(big.restored.length, 500);
  assert.equal(big.failed[0].name.length, 200);
  assert.equal(big.failed[0].error.length, 200);
});

test('parsePackageList: valid, blank, malformed', () => {
  const l = m.parsePackageList('curl=8.5.0-2\n\n  jq = 1.7.1-3  \n# comment\nnoversion\n=1.0\nbad name=1\nname=\npostgresql-client-17=17.2-1.pgdg120+1\n');
  assert.deepEqual(l, [
    { name: 'curl', version: '8.5.0-2' },
    { name: 'jq', version: '1.7.1-3' },
    { name: 'postgresql-client-17', version: '17.2-1.pgdg120+1' },
  ]);
});

test('parsePackageList: epoch versions keep their colon, only the first = splits', () => {
  assert.deepEqual(m.parsePackageList('git=1:2.43.0-1\n'), [{ name: 'git', version: '1:2.43.0-1' }]);
  assert.deepEqual(m.parsePackageList('a=b=c\n'), [{ name: 'a', version: 'b=c' }]);
});

test('parsePackageList: capped at 2000, junk input is empty', () => {
  const many = Array.from({ length: 2500 }, (_, i) => `p${i}=1`).join('\n');
  assert.equal(m.parsePackageList(many).length, 2000);
  for (const t of [undefined, null, '', 5]) assert.deepEqual(m.parsePackageList(t), []);
});

test('statusAlertKey: same container and at is the same key', () => {
  const a = m.statusAlertKey('rev4a-x', { at: 10 });
  assert.equal(a, m.statusAlertKey('rev4a-x', { at: 10 }));
  assert.notEqual(a, m.statusAlertKey('rev4a-x', { at: 11 }));
  assert.notEqual(a, m.statusAlertKey('rev4a-y', { at: 10 }));
  assert.equal(m.statusAlertKey('c', null), 'c@none');
});

test('splitFailed and failureMessage: the * pseudo-entry is the run, not a package', () => {
  const s = m.parseStatus(JSON.stringify({ at: 1, state: 'failed', failed: [{ name: 'a', error: 'x' }, { name: '*', error: 'timed out' }] }));
  assert.deepEqual(m.splitFailed(s).packages.map((f) => f.name), ['a']);
  assert.equal(m.splitFailed(s).runError, 'timed out');
  assert.equal(m.failureMessage('c1', s), 'Container c1: 1 system package(s) could not be reinstalled: a; the restore did not finish: timed out');
  const only = m.parseStatus(JSON.stringify({ at: 1, state: 'failed', failed: [{ name: '*', error: 'boom' }] }));
  assert.equal(m.failureMessage('c1', only), 'Container c1: the restore did not finish: boom');
  const none = m.parseStatus(JSON.stringify({ at: 1, state: 'partial', failed: [] }));
  assert.equal(m.failureMessage('c1', none), 'Container c1: the last restore did not complete');
  assert.equal(m.splitFailed(none).runError, null);
  assert.equal(m.failureMessage('c1', m.parseStatus('{"at":1,"state":"failed","failed":[{"name":"p","error":"e"}]}')), 'Container c1: 1 system package(s) could not be reinstalled: p');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
