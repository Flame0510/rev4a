import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContainerAnomalyDetector } = require('../lib/container-anomalies.js');

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
const TOTAL = 10_000;
let failed = 0;

/** Like the daemon: every anomaly returned is written, then marked. */
function obs(d, s, t) {
  const out = d.observe(s, t);
  for (const a of out) d.markRecorded(a.key, t);
  return out;
}
const sample = (rows, total = TOTAL) => ({ host: total === null ? null : { memTotalMb: total }, rows });
const row = (container, pids, mem_mb = 100) => ({ container, pids, mem_mb });

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
/** Feeds the same rows once a minute and returns the anomaly count of each sample. */
function run(d, rows, n, start = T0, step = MIN, total = TOTAL) {
  return Array.from({ length: n }, (_, i) => obs(d, sample(rows, total), start + i * step).length);
}

test('pids: one sample is not enough, two are', () => {
  const d = createContainerAnomalyDetector();
  assert.equal(obs(d, sample([row('a', 1500)]), T0).length, 0);
  const out = obs(d, sample([row('a', 1500)]), T0 + MIN);
  assert.equal(out.length, 1);
  assert.deepEqual(
    { key: out[0].key, metric: out[0].metric, container: out[0].container, values: out[0].values, threshold: out[0].threshold },
    { key: 'container_pids:a', metric: 'container_pids', container: 'a', values: [1500], threshold: 1000 },
  );
  assert.equal(out[0].message, 'Container a: 1500 processes for 2 consecutive samples');
});

test('pids: 999 never fires, 1000 does', () => {
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 999)], 5), [0, 0, 0, 0, 0]);
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1000)], 2), [0, 1]);
});

test('pids: a dip resets the streak', () => {
  const d = createContainerAnomalyDetector();
  assert.equal(obs(d, sample([row('a', 1200)]), T0).length, 0);
  assert.equal(obs(d, sample([row('a', 10)]), T0 + MIN).length, 0);
  assert.equal(obs(d, sample([row('a', 1200)]), T0 + 2 * MIN).length, 0);
  assert.equal(obs(d, sample([row('a', 1200)]), T0 + 3 * MIN).length, 1);
});

test('memory: 4 samples are not enough, 5 are', () => {
  const d = createContainerAnomalyDetector();
  assert.deepEqual(run(d, [row('a', 1, 9500)], 5), [0, 0, 0, 0, 1]);
});

test('memory: message and values', () => {
  const d = createContainerAnomalyDetector();
  let out = [];
  for (let i = 0; i < 5; i++) out = obs(d, sample([row('a', 1, 9500)]), T0 + i * MIN);
  assert.equal(out[0].metric, 'container_memory');
  assert.equal(out[0].key, 'container_memory:a');
  assert.equal(out[0].threshold, 90);
  assert.deepEqual(out[0].values, [95]);
  assert.equal(out[0].message, "Container a: memory 95% of Docker's 10000 MB for 5 consecutive samples");
});

test('memory: 89.9 % never fires, 90 % does', () => {
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, 8990)], 8), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, 9000)], 5), [0, 0, 0, 0, 1]);
});

test('memory: a gap resets the streak', () => {
  const d = createContainerAnomalyDetector();
  run(d, [row('a', 1, 9500)], 4);
  assert.equal(obs(d, sample([row('a', 1, 100)]), T0 + 4 * MIN).length, 0);
  assert.deepEqual(run(d, [row('a', 1, 9500)], 5, T0 + 5 * MIN), [0, 0, 0, 0, 1]);
});

test('memory: no rule without the Docker total', () => {
  for (const total of [null, 0, NaN, -5]) {
    assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, 9500)], 6, T0, MIN, total), [0, 0, 0, 0, 0, 0]);
  }
  const d = createContainerAnomalyDetector();
  assert.equal(obs(d, { rows: [row('a', 1, 9500)] }, T0).length, 0);
});

test('bad data breaks the streak and never alarms', () => {
  for (const bad of [null, undefined, 'x', NaN, Infinity]) {
    const d = createContainerAnomalyDetector();
    obs(d, sample([row('a', 1500, 9500)]), T0);
    obs(d, sample([{ container: 'a', pids: bad, mem_mb: bad }]), T0 + MIN);
    const out = obs(d, sample([row('a', 1500, 9500)]), T0 + 2 * MIN);
    assert.equal(out.length, 0, `streak survived ${String(bad)}`);
  }
  const d = createContainerAnomalyDetector();
  assert.deepEqual(obs(d, null, T0), []);
  assert.deepEqual(obs(d, { rows: 'nope' }, T0), []);
  assert.deepEqual(obs(d, sample([null, {}, { container: '' }, { container: 5, pids: 5000 }]), T0), []);
});

test('cooldown is per rule: pids and memory each wait their own 60 minutes', () => {
  const d = createContainerAnomalyDetector();
  const hot = sample([row('a', 1500, 9500)]);
  const first = [];
  for (let i = 0; i < 5; i++) first.push(...obs(d, hot, T0 + i * MIN)); // pids at +1, memory at +4
  assert.deepEqual(first.map((a) => a.metric), ['container_pids', 'container_memory']);
  // One sample a minute, as the daemon takes them (a longer gap would reset the streaks).
  const at = {};
  for (let m = 5; m <= 64; m++) for (const x of obs(d, hot, T0 + m * MIN)) at[x.metric] = m;
  assert.deepEqual(at, { container_pids: 61, container_memory: 64 }); // 60 min after +1 and +4
});

test('cooldown: exactly 59 and 60 minutes after a pids event', () => {
  const d = createContainerAnomalyDetector();
  const hot = sample([row('a', 1500)]);
  obs(d, hot, T0);
  assert.equal(obs(d, hot, T0 + MIN).length, 1);
  assert.equal(obs(d, hot, T0 + MIN + 59 * MIN).length, 0);
  assert.equal(obs(d, hot, T0 + MIN + 60 * MIN).length, 1);
});

test('two containers are independent', () => {
  const d = createContainerAnomalyDetector();
  obs(d, sample([row('a', 1500), row('b', 5)]), T0);
  let out = obs(d, sample([row('a', 1500), row('b', 1500)]), T0 + MIN);
  assert.deepEqual(out.map((a) => a.container), ['a']);
  out = obs(d, sample([row('a', 1500), row('b', 1500)]), T0 + 2 * MIN);
  assert.deepEqual(out.map((a) => a.container), ['b']); // a is in cooldown, b reaches its second sample
});

test('a container missing from a sample loses its streak', () => {
  const d = createContainerAnomalyDetector();
  obs(d, sample([row('a', 1500)]), T0);
  obs(d, sample([row('b', 1)]), T0 + MIN);
  assert.equal(obs(d, sample([row('a', 1500)]), T0 + 2 * MIN).length, 0);
  assert.equal(obs(d, sample([row('a', 1500)]), T0 + 3 * MIN).length, 1);
});

test('a vanished container is forgotten', () => {
  const d = createContainerAnomalyDetector();
  for (let i = 0; i < 3; i++) obs(d, sample([row('gone', 1500)]), T0 + i * MIN);
  // Absent for longer than the cooldown: when it comes back it starts from zero, with no cooldown left.
  obs(d, sample([row('other', 1)]), T0 + 3 * MIN);
  obs(d, sample([row('other', 1)]), T0 + 70 * MIN);
  assert.equal(obs(d, sample([row('gone', 1500)]), T0 + 71 * MIN).length, 0);
  assert.equal(obs(d, sample([row('gone', 1500)]), T0 + 72 * MIN).length, 1);
});

test('many short-lived containers do not accumulate state', () => {
  const d = createContainerAnomalyDetector();
  for (let i = 0; i < 200; i++) {
    obs(d, sample([row(`c${i}`, 1500)]), T0 + i * 2 * MIN);
    obs(d, sample([row(`c${i}`, 1500)]), T0 + i * 2 * MIN + MIN);
  }
  // Only observable through behavior: a fresh name still needs two samples.
  assert.equal(obs(d, sample([row('fresh', 1500)]), T0 + 1000 * MIN).length, 0);
});

test('a write that fails leaves the alert due; a recorded one starts the cooldown', () => {
  const d = createContainerAnomalyDetector();
  const hot = sample([row('a', 1500)]);
  d.observe(hot, T0);
  let out = d.observe(hot, T0 + MIN); // due, but the write "fails": no markRecorded
  assert.equal(out.length, 1);
  out = d.observe(hot, T0 + 2 * MIN); // fires again
  assert.equal(out.length, 1);
  d.markRecorded(out[0].key, T0 + 2 * MIN);
  assert.equal(d.observe(hot, T0 + 3 * MIN).length, 0);
  assert.equal(d.observe(hot, T0 + 2 * MIN + 59 * MIN).length, 0);
  assert.equal(d.observe(hot, T0 + 2 * MIN + 60 * MIN).length, 1);
});

test('one failed write does not hold back the others', () => {
  const d = createContainerAnomalyDetector();
  const hot = sample([row('a', 1500), row('b', 1500)]);
  d.observe(hot, T0);
  const out = d.observe(hot, T0 + MIN);
  assert.equal(out.length, 2);
  d.markRecorded(out[1].key, T0 + MIN); // only b was stored
  assert.deepEqual(d.observe(hot, T0 + 2 * MIN).map((a) => a.container), ['a']);
});

test('huge finite values never overflow into an alarm', () => {
  const big = Number.MAX_VALUE;
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, big)], 6, T0, MIN, big), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, big)], 6, T0, MIN, 1000), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(run(createContainerAnomalyDetector(), [row('a', 1, 1000)], 6, T0, MIN, big), [0, 0, 0, 0, 0, 0]);
});

const src = (...names) => names.map((container) => ({ container }));
const withSources = (rows, sources) => ({ ...sample(rows), sources });

test('stats missing (in sources, not in rows) keeps the streak unchanged', () => {
  const d = createContainerAnomalyDetector();
  assert.equal(obs(d, withSources([row('a', 1500)], src('a')), T0).length, 0);
  assert.equal(obs(d, withSources([], src('a')), T0 + MIN).length, 0); // no read: no increment
  assert.equal(obs(d, withSources([row('a', 1500)], src('a')), T0 + 2 * MIN).length, 1); // second hot read
});

test('stats missing does not reset a streak either', () => {
  const d = createContainerAnomalyDetector();
  obs(d, withSources([row('a', 1500)], src('a')), T0);
  for (let i = 1; i <= 3; i++) obs(d, withSources([], src('a')), T0 + i * MIN);
  assert.equal(obs(d, withSources([row('a', 1500)], src('a')), T0 + 4 * MIN).length, 1);
});

test('absent from rows and sources is forgotten', () => {
  const d = createContainerAnomalyDetector();
  obs(d, withSources([row('a', 1500)], src('a')), T0);
  obs(d, withSources([], src('b')), T0 + MIN);
  assert.equal(obs(d, withSources([row('a', 1500)], src('a', 'b')), T0 + 2 * MIN).length, 0);
});

test('a sample without sources: absent from rows is forgotten', () => {
  const d = createContainerAnomalyDetector();
  obs(d, sample([row('a', 1500)]), T0);
  obs(d, sample([]), T0 + MIN);
  assert.equal(obs(d, sample([row('a', 1500)]), T0 + 2 * MIN).length, 0);
});

test('a gap over 180 s resets every streak; exactly 180 s does not', () => {
  const d = createContainerAnomalyDetector();
  obs(d, sample([row('a', 1500)]), T0);
  assert.equal(obs(d, sample([row('a', 1500)]), T0 + 180 * 1000 + 1).length, 0);
  assert.equal(obs(d, sample([row('a', 1500)]), T0 + 180 * 1000 + 1 + MIN).length, 1);
  const e = createContainerAnomalyDetector();
  obs(e, sample([row('a', 1500)]), T0);
  assert.equal(obs(e, sample([row('a', 1500)]), T0 + 180 * 1000).length, 1);
});

test('a gap also resets the streak of a container whose stats are missing', () => {
  const d = createContainerAnomalyDetector();
  obs(d, withSources([row('a', 1500)], src('a')), T0);
  obs(d, withSources([], src('a')), T0 + 3 * 60 * 60 * 1000);
  assert.equal(obs(d, withSources([row('a', 1500)], src('a')), T0 + 3 * 60 * 60 * 1000 + MIN).length, 0);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
