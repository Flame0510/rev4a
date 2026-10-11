import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const m = require('../lib/agent-memory-limit.js');
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

test('parseLimitMb: no limit', () => {
  for (const v of [null, undefined, '', '   ', 0, '0', ' 0 ']) assert.equal(m.parseLimitMb(v), null, String(v));
});

test('parseLimitMb: bounds', () => {
  assert.throws(() => m.parseLimitMb(255), /at least 256/);
  assert.equal(m.parseLimitMb(256), 256);
  assert.equal(m.parseLimitMb(1048576), 1048576);
  assert.throws(() => m.parseLimitMb(1048577), /at most 1048576/);
  assert.throws(() => m.parseLimitMb('255'), /at least 256/);
  assert.equal(m.parseLimitMb('1048576'), 1048576);
});

test('parseLimitMb: accepted forms', () => {
  assert.equal(m.parseLimitMb(512), 512);
  assert.equal(m.parseLimitMb('512'), 512);
  assert.equal(m.parseLimitMb(' 512 '), 512);
  assert.equal(m.parseLimitMb('0512'), 512);
});

test('parseLimitMb: rejected forms', () => {
  for (const v of ['512.5', 512.5, '-1', -1, '1e3', 1e-3, '512MB', '2GB', '5 12', 'abc', NaN, Infinity, -Infinity, '+512', '0x200', {}, [], true, '١٢٣']) {
    assert.throws(() => m.parseLimitMb(v), Error, String(v));
  }
});

test('parseGbInput / mbToGbText', () => {
  assert.equal(m.parseGbInput('2'), 2048);
  assert.equal(m.parseGbInput(' 2.5 '), 2560);
  assert.equal(m.parseGbInput('0.25'), 256);
  assert.equal(m.parseGbInput('1.5'), 1536);
  assert.equal(m.parseGbInput('0.977'), 1000);
  assert.equal(m.parseGbInput('2,5'), 2560);
  assert.equal(m.parseGbInput(' 0,25 '), 256);
  assert.equal(m.parseGbInput('1024'), 1048576);
  for (const v of ['', '  ', '0', '0.2', '1025', '-1', '1e1', '2GB', 'abc', '1,000.5', '2,5,1', '.5', '5.', undefined, null, '9'.repeat(400)]) assert.throws(() => m.parseGbInput(v), Error, String(v));
  assert.equal(m.mbToGbText(2560), '2.5');
  assert.equal(m.mbToGbText(2048), '2');
  assert.equal(m.mbToGbText(1000), '0.9765625');
  assert.equal(m.mbToGbText(277), '0.2705078125');
  assert.equal(m.mbToGbText(null), '');
  // Every MB the API accepts survives the round trip through the custom field.
  for (let mb = 256; mb <= 1048576; mb++) {
    if (m.parseGbInput(m.mbToGbText(mb)) !== mb) assert.fail(`round trip failed for ${mb} MB`);
  }
  // Errors speak in GB.
  assert.throws(() => m.parseGbInput('0.2'), /at least 0\.25 GB/);
  assert.throws(() => m.parseGbInput('1025'), /at most 1024 GB/);
  assert.throws(() => m.parseGbInput('9'.repeat(400)), /at most 1024 GB/);
  assert.throws(() => m.parseGbInput('abc'), /Enter a size in GB, like 2 or 2\.5/);
  assert.deepEqual(m.MEMORY_PRESETS_MB.slice(0, 3), [1536, 2048, 3072]);
  for (const p of m.MEMORY_PRESETS_MB) assert.equal(m.parseLimitMb(p), p);
});

test('mbToBytes / bytesToMb', () => {
  assert.equal(m.mbToBytes(512), 536870912);
  assert.equal(m.bytesToMb(536870912), 512);
  assert.equal(m.bytesToMb(536870912 + 1048575), 512);
  assert.equal(m.bytesToMb(1048575), 0);
  for (const v of [0, -1, NaN, null, undefined, '5']) assert.equal(m.bytesToMb(v), null, String(v));
});

test('formatLimit', () => {
  assert.equal(m.formatLimit(null), 'none');
  assert.equal(m.formatLimit(undefined), 'none');
  assert.equal(m.formatLimit(512), '512 MB');
  assert.equal(m.formatLimit(1023), '1023 MB');
  assert.equal(m.formatLimit(1024), '1 GB');
  assert.equal(m.formatLimit(1536), '1.5 GB');
  assert.equal(m.formatLimit(2048), '2 GB');
  assert.equal(m.formatLimit(1048576), '1024 GB');
});

test('limitArgs: only real values', () => {
  assert.deepEqual(m.limitArgs(0, 0), []);
  assert.deepEqual(m.limitArgs(null, null), []);
  assert.deepEqual(m.limitArgs(undefined, undefined), []);
  assert.deepEqual(m.limitArgs(NaN, NaN), []);
  assert.deepEqual(m.limitArgs(-5, -5), []);
  assert.deepEqual(m.limitArgs(-1, 0), []);
  assert.deepEqual(m.limitArgs(1.5, 2.5), []);
  assert.deepEqual(m.limitArgs(2147483648, 2147483648), ['--memory', '2147483648', '--memory-swap', '2147483648']);
  assert.deepEqual(m.limitArgs(2147483648, -1), ['--memory', '2147483648', '--memory-swap', '-1']);
  assert.deepEqual(m.limitArgs(2147483648, 0), ['--memory', '2147483648']);
  assert.deepEqual(m.limitArgs(2147483648), ['--memory', '2147483648']);
});

test('rebuildLimitArgs: carry, remove, set', () => {
  const none = { NetworkMode: 'bridge' };
  const limited = { Memory: 2147483648, MemorySwap: 2147483648 };
  // (a) an inspect with no limit
  assert.deepEqual(m.rebuildLimitArgs(none, undefined), []);
  assert.deepEqual(m.rebuildLimitArgs(undefined, undefined), []);
  assert.deepEqual(m.rebuildLimitArgs({ Memory: 0, MemorySwap: 0 }, undefined), []);
  // (b) 2 GiB carried from the inspect
  assert.deepEqual(m.rebuildLimitArgs(limited, undefined), ['--memory', '2147483648', '--memory-swap', '2147483648']);
  // (c) null removes it
  assert.deepEqual(m.rebuildLimitArgs(limited, null), []);
  // a number sets it, swap equal, whatever the inspect says
  assert.deepEqual(m.rebuildLimitArgs(none, 512), ['--memory', '536870912', '--memory-swap', '536870912']);
  assert.deepEqual(m.rebuildLimitArgs(limited, 512), ['--memory', '536870912', '--memory-swap', '536870912']);
  console.log('     (a) []  (b)', JSON.stringify(m.rebuildLimitArgs(limited, undefined)), ' (c) []');
});

const ev = (name, time, extra = {}) => ({
  Type: 'container', Action: 'oom', time, timeNano: time * 1e9,
  Actor: { ID: 'abc', Attributes: { name, AGENT_ID: name, image: 'x' } }, ...extra,
});

test('oomEventsToAnomalies', () => {
  const out = m.oomEventsToAnomalies([
    ev('a', 100), ev('a', 100), ev('a', 101), ev('b', 100),
    { Type: 'container', Action: 'oom', time: 5, Actor: { Attributes: { name: 'plain' } } }, // no AGENT_ID
    { Type: 'container', Action: 'die', time: 5, Actor: { Attributes: { name: 'c', AGENT_ID: 'c' } } },
    null, 'x', 5, {}, { Type: 'container', Action: 'oom' },
    { Type: 'container', Action: 'oom', Actor: { Attributes: { name: 'd', AGENT_ID: 'd' } } }, // no time
  ], { a: 2048 });
  assert.deepEqual(out.map((o) => [o.container, o.time, o.limitMb]), [['a', 100, 2048], ['a', 101, 2048], ['b', 100, null]]);
  assert.equal(out[0].message, 'Container a: a process was killed, out of memory (limit 2 GB)');
  assert.equal(out[2].message, 'Container b: a process was killed, out of memory (no memory limit set)');
  assert.deepEqual(out[2].values, [null]);
  assert.deepEqual(m.oomEventsToAnomalies(undefined), []);
  assert.deepEqual(m.oomEventsToAnomalies('nope'), []);
});

test('parseEventStream', () => {
  assert.deepEqual(m.parseEventStream(''), []);
  assert.deepEqual(m.parseEventStream(undefined), []);
  assert.deepEqual(m.parseEventStream('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(m.parseEventStream('{"a":1}\n{"b":'), [{ a: 1 }]);
  assert.deepEqual(m.parseEventStream('[1]\n5\n"x"\n'), []);
});

test('createLineSplitter: lines across chunk boundaries', () => {
  const sp = m.createLineSplitter();
  assert.deepEqual(sp.push('{"a":1}\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(sp.push(':2}'), []);
  assert.deepEqual(sp.push('\n\nnot json\n{"c":3}\n[1]\n{"d"'), [{ b: 2 }, { c: 3 }]);
  assert.deepEqual(sp.push(Buffer.from(':4}\n')), [{ d: 4 }]);
  assert.deepEqual(sp.push(''), []);
});

test('createOomTracker: cooldown, counting, retry', () => {
  const min = 60000;
  const ev = (t) => m.oomEventsToAnomalies([{ Type: 'container', Action: 'oom', time: t, timeNano: t * 1e9,
    Actor: { Attributes: { name: 'a', AGENT_ID: 'a' } } }], { a: 2048 })[0];
  const tr = m.createOomTracker();
  assert.deepEqual(tr.due(0), []);
  assert.equal(tr.kill(ev(1), 0), true);
  assert.equal(tr.kill(ev(1), 0), false); // replayed event
  let due = tr.due(0);
  assert.equal(due.length, 1);
  assert.equal(due[0].message, 'Container a: a process was killed, out of memory (limit 2 GB)');
  assert.equal(tr.due(30000).length, 1); // write failed: still pending
  tr.markRecorded('a', 30000);
  assert.deepEqual(tr.due(31000), []);
  tr.kill(ev(2), 2 * min);
  tr.kill(ev(3), 4 * min);
  assert.deepEqual(tr.due(9 * min), []); // inside the cooldown
  due = tr.due(10 * min + 30000);
  assert.equal(due.length, 1);
  assert.equal(due[0].kills, 2);
  assert.match(due[0].message, /; 2 kills in the last 9 minutes$/);
  tr.markRecorded('a', 10 * min + 30000);
  assert.deepEqual(tr.due(30 * min), []);
  assert.equal(tr.kill(null, 0), false);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
