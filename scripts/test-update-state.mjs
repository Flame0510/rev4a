import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../lib/update-state.js');

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const alive = () => true;
const dead = () => false;
let failed = 0;

function test(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rev4a-update-state-'));
  try { fn(dir); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// The reading server started long before the update unless a test says otherwise.
const opts = (over = {}) => ({ now: T0 + MIN, isAlive: alive, startedAt: T0 - 60 * MIN, isServer: true, ...over });

test('no file: no update', (dir) => {
  assert.equal(S.readUpdate(dir, opts()), null);
  assert.equal(S.currentUpdate(dir, opts()), null);
});

test('malformed file: no update', (dir) => {
  writeFileSync(S.stateFile(dir), '{ not json');
  assert.equal(S.readUpdate(dir, opts()), null);
  writeFileSync(S.stateFile(dir), JSON.stringify({ phase: 'unknown', startedAt: T0, updatedAt: T0 }));
  assert.equal(S.readUpdate(dir, opts()), null);
});

test('in progress: every running phase is current while the pid lives', (dir) => {
  for (const phase of ['starting', 'installing', 'building']) {
    S.writeUpdate(dir, phase, { from: '1.0.0', to: '1.1.0' }, T0);
    const cur = S.currentUpdate(dir, opts());
    assert.equal(cur.phase, phase);
    assert.equal(cur.from, '1.0.0');
    assert.equal(cur.to, '1.1.0');
  }
});

test('a run keeps startedAt, from and to across phases; starting begins a new run', (dir) => {
  S.writeUpdate(dir, 'starting', { from: '1.0.0' }, T0);
  S.writeUpdate(dir, 'installing', { to: '1.1.0' }, T0 + MIN);
  const s = S.readUpdate(dir, opts({ now: T0 + 2 * MIN }));
  assert.equal(s.startedAt, T0);
  assert.equal(s.updatedAt, T0 + MIN);
  assert.deepEqual([s.from, s.to], ['1.0.0', '1.1.0']);
  S.writeUpdate(dir, 'starting', { from: '1.1.0' }, T0 + 5 * MIN);
  assert.equal(S.readUpdate(dir, opts({ now: T0 + 6 * MIN })).startedAt, T0 + 5 * MIN);
});

test('pid gone while installing or building: failed, and it is written down', (dir) => {
  S.writeUpdate(dir, 'building', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.readUpdate(dir, opts({ isAlive: dead }));
  assert.equal(s.phase, 'failed');
  assert.match(s.error, /stopped before it finished/);
  assert.equal(S.currentUpdate(dir, opts({ isAlive: alive })), null, 'stays failed even if a pid answers later');
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).phase, 'failed');
});

test('pid gone while starting: failed too', (dir) => {
  S.writeUpdate(dir, 'starting', {}, T0);
  assert.equal(S.readUpdate(dir, opts({ isAlive: dead })).phase, 'failed');
});

test('restarting: the updater exits on purpose, a dead pid is not a failure', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.currentUpdate(dir, opts({ isAlive: dead }));
  assert.equal(s.phase, 'restarting');
});

test('restarting that never happens fails after 5 minutes, not 30', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const old = T0 - 60 * MIN;
  assert.equal(S.readUpdate(dir, opts({ now: T0 + 5 * MIN, startedAt: old })).phase, 'restarting');
  const s = S.readUpdate(dir, opts({ now: T0 + 5 * MIN + 1, startedAt: old }));
  assert.equal(s.phase, 'failed');
  assert.match(s.error, /did not restart/);
});

test('restarting becomes done when a server started after it answers', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.readUpdate(dir, opts({ startedAt: T0 + 30_000, isAlive: dead }));
  assert.equal(s.phase, 'done');
  assert.equal(S.currentUpdate(dir, opts({ startedAt: T0 - 60 * MIN })), null, 'done is persisted, not in progress');
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).phase, 'done');
});

test('done and failed are not in progress but still readable', (dir) => {
  S.writeUpdate(dir, 'done', { from: '1.0.0', to: '1.1.0' }, T0);
  assert.equal(S.currentUpdate(dir, opts()), null);
  assert.equal(S.readUpdate(dir, opts()).phase, 'done');
  S.writeUpdate(dir, 'failed', { error: 'npm exploded' }, T0);
  assert.equal(S.currentUpdate(dir, opts()), null);
  const f = S.readUpdate(dir, opts());
  assert.equal(f.phase, 'failed');
  assert.equal(f.error, 'npm exploded');
});

test('failed keeps a bounded error', (dir) => {
  S.writeUpdate(dir, 'failed', { error: 'x'.repeat(5000) }, T0);
  assert.equal(S.readUpdate(dir, opts()).error.length, 600);
});

test('stale: older than 30 minutes is not an update, whatever the phase', (dir) => {
  for (const phase of ['installing', 'restarting', 'failed', 'done']) {
    S.writeUpdate(dir, phase, {}, T0);
    assert.equal(S.readUpdate(dir, opts({ now: T0 + 30 * MIN })) === null, false, `${phase} at exactly 30 min still counts`);
    // A read may rewrite the state (restarting past 5 minutes becomes failed): start again.
    S.writeUpdate(dir, phase, {}, T0);
    assert.equal(S.readUpdate(dir, opts({ now: T0 + 30 * MIN + 1 })), null, `${phase} just over 30 min`);
  }
});

test('stale file left by a crash does not block: restarting for an hour is not in progress', (dir) => {
  S.writeUpdate(dir, 'restarting', {}, T0);
  assert.equal(S.currentUpdate(dir, opts({ now: T0 + 60 * MIN })), null);
});

test('clearUpdate removes the file; writes leave no temporary file behind', (dir) => {
  S.writeUpdate(dir, 'installing', {}, T0);
  S.clearUpdate(dir);
  assert.equal(existsSync(S.stateFile(dir)), false);
  S.clearUpdate(dir);
  S.writeUpdate(dir, 'installing', {}, T0);
  assert.equal(existsSync(`${S.stateFile(dir)}.${process.pid}.tmp`), false);
});

test('pidAlive: this process lives, a nonsense pid does not', () => {
  assert.equal(S.pidAlive(process.pid), true);
  assert.equal(S.pidAlive(0), false);
  assert.equal(S.pidAlive(-5), false);
  assert.equal(S.pidAlive(null), false);
  assert.equal(S.pidAlive(2 ** 30), false);
});

test('claim: a second claim is refused while the first run is in progress', (dir) => {
  const a = S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  assert.equal(a.ok, true);
  assert.equal(a.state.claim, 'A');
  const b = S.claimUpdate(dir, { from: '1.0.0', claim: 'B', pid: 222, opts: opts({ now: T0 + 1000 }) });
  assert.equal(b.ok, false);
  assert.equal(b.state.claim, 'A');
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).claim, 'A', 'the loser wrote nothing');
});

test('claim: an inherited claim is not a competitor, a different inherited one is', (dir) => {
  S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  assert.equal(S.claimUpdate(dir, { from: '1.0.0', claim: 'A', inherited: true, pid: 222, opts: opts({ now: T0 + 1000 }) }).ok, true);
  assert.equal(S.claimUpdate(dir, { from: '1.0.0', claim: 'B', inherited: true, pid: 333, opts: opts({ now: T0 + 2000 }) }).ok, false);
});

test('claim: the updater taking over the dashboard claim keeps its startedAt (the log marker carries it)', (dir) => {
  const a = S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  const b = S.claimUpdate(dir, { from: '1.0.0', claim: 'A', inherited: true, pid: 222, opts: opts({ now: T0 + 5000 }) });
  assert.equal(b.state.startedAt, a.state.startedAt);
  assert.equal(b.state.pid, 222);
  const c = S.claimUpdate(dir, { from: '1.0.0', claim: 'C', pid: 333, opts: opts({ now: T0 + 40 * MIN }) });
  assert.equal(c.state.startedAt, T0 + 40 * MIN, 'a new run starts its own clock');
});

test('claim: a finished, failed, stale or dead run does not block a new one', (dir) => {
  S.writeUpdate(dir, 'done', {}, T0);
  assert.equal(S.claimUpdate(dir, { claim: 'A', pid: 1, opts: opts() }).ok, true);
  S.writeUpdate(dir, 'failed', { error: 'x' }, T0);
  assert.equal(S.claimUpdate(dir, { claim: 'B', pid: 1, opts: opts() }).ok, true);
  S.writeUpdate(dir, 'installing', {}, T0);
  assert.equal(S.claimUpdate(dir, { claim: 'C', pid: 1, opts: opts({ now: T0 + 31 * MIN }) }).ok, true, 'stale');
  S.writeUpdate(dir, 'installing', {}, T0);
  assert.equal(S.claimUpdate(dir, { claim: 'D', pid: 1, opts: opts({ isAlive: dead }) }).ok, true, 'dead updater');
});

test('claim: the phases the updater writes keep the claim', (dir) => {
  S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  S.writeUpdate(dir, 'installing', { to: '1.1.0' }, T0 + 1000);
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).claim, 'A');
});

test('adoptPid: replaces the pid only while the state carries the same claim', (dir) => {
  S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  assert.equal(S.adoptPid(dir, 'A', 999), true);
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).pid, 999);
  assert.equal(S.adoptPid(dir, 'other', 5), false, 'another claim');
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).pid, 999);
  S.clearUpdate(dir);
  assert.equal(S.adoptPid(dir, 'A', 7), false, 'a fast child cleared its state: nothing is rewritten');
  assert.equal(existsSync(S.stateFile(dir)), false);
});

test('adoptPid: a state the updater already moved on or failed keeps its phase', (dir) => {
  S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  S.writeUpdate(dir, 'failed', { error: 'boom', pid: 5 }, T0 + 1000);
  S.adoptPid(dir, 'A', 999);
  const raw = JSON.parse(readFileSync(S.stateFile(dir), 'utf-8'));
  assert.equal(raw.phase, 'failed');
  assert.equal(raw.error, 'boom');
});

test('failClaimed: marks the claimed run failed, leaves another run alone', (dir) => {
  S.claimUpdate(dir, { from: '1.0.0', claim: 'A', pid: 111, opts: opts({ now: T0 }) });
  assert.equal(S.failClaimed(dir, 'other', 'x', T0), false);
  assert.equal(S.failClaimed(dir, 'A', 'spawn ENOENT', T0 + 1000), true);
  const s = S.readUpdate(dir, opts({ now: T0 + 2000 }));
  assert.equal(s.phase, 'failed');
  assert.equal(s.error, 'spawn ENOENT');
});

test('restarting + restarted server on the target version: done', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.readUpdate(dir, opts({ startedAt: T0 + 30_000, runningVersion: '1.1.0' }));
  assert.equal(s.phase, 'done');
});

test('restarting + restarted server on another version: failed with the versions', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.readUpdate(dir, opts({ startedAt: T0 + 30_000, runningVersion: '1.0.0' }));
  assert.equal(s.phase, 'failed');
  assert.equal(s.error, 'Rev4a restarted on 1.0.0, not 1.1.0');
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).phase, 'failed');
});

test('restarting with the target unknown keeps the plain rule: done', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0' }, T0);
  assert.equal(S.readUpdate(dir, opts({ startedAt: T0 + 30_000, runningVersion: '1.0.0' })).phase, 'done');
});

test('restarting while the old server still runs stays restarting, whatever its version', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  assert.equal(S.readUpdate(dir, opts({ startedAt: T0 - 60 * MIN, runningVersion: '1.0.0' })).phase, 'restarting');
});

test('a reader that is not the server never resolves restarting, on disk too', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  for (const runningVersion of ['1.1.0', '1.0.0', null]) {
    const s = S.readUpdate(dir, opts({ isServer: false, startedAt: T0 + 30_000, runningVersion }));
    assert.equal(s.phase, 'restarting');
  }
  assert.equal(JSON.parse(readFileSync(S.stateFile(dir), 'utf-8')).phase, 'restarting');
  assert.equal(S.currentUpdate(dir, opts({ isServer: false, startedAt: T0 + 30_000 })).phase, 'restarting');
});

test('a reader that is not the server still fails restarting after 5 minutes', (dir) => {
  S.writeUpdate(dir, 'restarting', { from: '1.0.0', to: '1.1.0' }, T0);
  const s = S.readUpdate(dir, opts({ isServer: false, now: T0 + 5 * MIN + 1, startedAt: T0 + 30_000 }));
  assert.equal(s.phase, 'failed');
  assert.match(s.error, /did not restart/);
});

test('a state written more than 5 minutes in the future is stale (clock step)', (dir) => {
  S.writeUpdate(dir, 'installing', {}, T0 + 5 * MIN);
  assert.notEqual(S.readUpdate(dir, opts({ now: T0 })), null, 'exactly 5 minutes ahead still counts');
  assert.equal(S.readUpdate(dir, opts({ now: T0 - 1 })), null, 'just over 5 minutes ahead');
  assert.equal(S.currentUpdate(dir, opts({ now: T0 - 1 })), null);
});

test('redact: secret-looking names lose their values', () => {
  assert.equal(S.redact('NPM_TOKEN=abc123'), 'NPM_TOKEN=[redacted]');
  assert.equal(S.redact('//registry.npmjs.org/:_authToken=abc123'), '//registry.npmjs.org/:_authToken=[redacted]');
  assert.equal(S.redact('password: hunter2 next'), 'password: [redacted]');
  assert.equal(S.redact('FOO=1 NPM_TOKEN=abc123 BAR=2'), 'FOO=1 NPM_TOKEN=[redacted] BAR=2');
  assert.equal(S.redact('API_SECRET = "a b c" x'), 'API_SECRET = [redacted] x');
  assert.equal(S.redact('ssh_key=abc'), 'ssh_key=[redacted]');
});

test('redact: Bearer, npm tokens, sk- keys and URL credentials', () => {
  assert.match(S.redact('Authorization: Bearer abc.def.ghi'), /^Authorization: \[redacted\]/);
  assert.equal(S.redact('curl -H Bearer abc.def'), 'curl -H Bearer [redacted]');
  assert.equal(S.redact('token npm_abcdefghij1234567890 used'), 'token [redacted] used');
  assert.equal(S.redact('key sk-proj-abc123def456ghi used'), 'key [redacted] used');
  assert.equal(S.redact('GET https://user:pass@registry.example.com/x'), 'GET https://[redacted]@registry.example.com/x');
  for (const secret of ['hunter2', 'abc123', 'abc.def.ghi', 'abcdefghij1234567890', 'user:pass']) {
    assert.equal(S.redact(`NPM_TOKEN=${secret} password=${secret}`).includes(secret), false);
  }
});

test('redact: Basic, token-only URLs, GitHub/Slack/AWS keys, --password, a value after a marker', () => {
  const cases = {
    'Authorization: Basic dXNlcjpwYXNz': 'dXNlcjpwYXNz',
    'https://ghp_abcdefghij1234567890ab@github.com/x': 'ghp_abcdefghij1234567890ab',
    'push github_pat_11ABCDEFG0123456789_abcdefghij': 'github_pat_11ABCDEFG0123456789_abcdefghij',
    'slack xoxb-1234567890-abcdef': 'xoxb-1234567890-abcdef',
    'aws AKIAABCDEFGHIJKLMNOP': 'AKIAABCDEFGHIJKLMNOP',
    '--password hunter2': 'hunter2',
    'token abcdefghijklmnop1234': 'abcdefghijklmnop1234',
    'KEY = [redacted]secret': 'secret',
    '--password=hunter2': 'hunter2',
    '"password":"hunter2"': 'hunter2',
    'api_key: [redacted] hunter2': 'hunter2',
    'TOKEN= [redacted] leak': 'leak',
    'redis://:hunter2@localhost:6379': 'hunter2',
    'glpat-abcdefghijklmnopqrst': 'glpat-abcdefghijklmnopqrst',
    'AIzaSyA1234567890abcdefghijklmnopqrstu': 'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig': 'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'Set-Cookie: sid=zzz9; Path=/': 'zzz9',
  };
  for (const [line, secret] of Object.entries(cases)) assert.equal(S.redact(line).includes(secret), false, line);
});

test('redact: ordinary npm and build output is untouched', () => {
  for (const line of [
    'npm http fetch GET 200 https://registry.npmjs.org/next 120ms', 'added 412 packages in 38s', '✓ Compiled successfully in 41s',
    'npm error Unable to authenticate, your authentication token seems to be invalid.', 'author: the maintainer',
    'monkey: banana', 'tokenizer: 1.2.3', 'node_modules/keyv: 4.5.4', 'FOO=1 BAR=2',
  ]) {
    assert.equal(S.redact(line), line);
  }
});

test('redact: a long line is cut and stays fast (no runaway backtracking)', () => {
  const t = Date.now();
  for (const blob of ['KEY'.repeat(6000), 'a='.repeat(8000), 'k: '.repeat(6000), 'ab'.repeat(8000)]) {
    for (let i = 0; i < 20; i++) assert.ok(S.redact(blob).length <= 501);
  }
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

process.exit(failed ? 1 : 0);
