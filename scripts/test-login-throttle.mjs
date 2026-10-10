import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoginThrottle } = require('../lib/login-throttle.js');
const { clientAddress, isPrivateOrLoopback } = require('../lib/client-address.js');

const S = 1000;
const MIN = 60 * S;
let failed = 0;
let t = 1_800_000_000_000;

function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
function fresh(opts = {}) {
  t = 1_800_000_000_000;
  return createLoginThrottle({ now: () => t, ...opts });
}

test('failures 1 to 5 are free', () => {
  const th = fresh();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(th.check('a'), { allowed: true });
    th.fail('a');
  }
  assert.deepEqual(th.check('a'), { allowed: true });
});

test('6th failure locks for 30 s, 7th for 60 s', () => {
  const th = fresh();
  for (let i = 0; i < 6; i++) th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 30 });
  t += 30 * S;
  assert.deepEqual(th.check('a'), { allowed: true });
  th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 60 });
});

test('the lock is capped at 15 minutes', () => {
  const th = fresh();
  for (let i = 0; i < 30; i++) th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 900 });
});

test('Retry-After rounds up and is at least 1', () => {
  const th = fresh();
  for (let i = 0; i < 6; i++) th.fail('a');
  t += 29_001;
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 1 });
  t += 998;
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 1 });
  t += 1;
  assert.deepEqual(th.check('a'), { allowed: true });
});

test('failures older than the window are forgotten', () => {
  const th = fresh();
  for (let i = 0; i < 5; i++) th.fail('a');
  t += 15 * MIN;
  th.fail('a'); // would be the 6th without the window
  assert.deepEqual(th.check('a'), { allowed: true });
  assert.equal(th.size(), 1);
  t += 15 * MIN;
  assert.deepEqual(th.check('a'), { allowed: true });
  assert.equal(th.size(), 0);
});

test('a success clears the key', () => {
  const th = fresh();
  for (let i = 0; i < 5; i++) th.fail('a');
  th.succeed('a');
  th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: true });
  assert.equal(th.size(), 1);
});

test('keys are isolated', () => {
  const th = fresh();
  for (let i = 0; i < 10; i++) th.fail('a');
  assert.equal(th.check('a').allowed, false);
  assert.deepEqual(th.check('b'), { allowed: true });
});

test('the map is bounded and evicts the least recently active key', () => {
  const th = fresh({ maxKeys: 10_000 });
  for (let i = 0; i < 10_000; i++) { t += 1; th.fail(`k${i}`); }
  assert.equal(th.size(), 10_000);
  t += 1;
  th.fail('k0'); // k0 is active again, so k1 is now the oldest
  t += 1;
  th.fail('new');
  assert.equal(th.size(), 10_000);
  const small = fresh({ maxKeys: 3 });
  for (const k of ['a', 'b', 'c']) { for (let i = 0; i < 6; i++) small.fail(k); t += 1; }
  small.fail('a'); // a is the most recent, b the least
  t += 1;
  small.fail('d');
  assert.equal(small.size(), 3);
  assert.deepEqual(small.check('b'), { allowed: true }); // evicted, so its lock is gone
  assert.equal(small.check('a').allowed, false);
  assert.equal(small.check('c').allowed, false);
});

test('clientAddress: public peer ignores a spoofed X-Forwarded-For', () => {
  assert.equal(clientAddress('8.8.8.8', '1.1.1.1'), '8.8.8.8');
  assert.equal(clientAddress('::ffff:8.8.4.4', '1.1.1.1, 2.2.2.2'), '8.8.4.4');
});

test('clientAddress: loopback peer uses the rightmost entry', () => {
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, 2.2.2.2'), '2.2.2.2');
  assert.equal(clientAddress('::1', '2.2.2.2'), '2.2.2.2');
  assert.equal(clientAddress('172.18.0.2', ' 2.2.2.2 '), '2.2.2.2');
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, 2001:DB8::1'), '2001:db8::1');
});

test('clientAddress: IPv4-mapped loopback peer counts as loopback', () => {
  assert.equal(clientAddress('::ffff:127.0.0.1', '3.3.3.3'), '3.3.3.3');
  assert.equal(clientAddress('::ffff:127.0.0.1', undefined), '127.0.0.1');
});

test('clientAddress: a malformed rightmost entry falls back to the socket address', () => {
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, not-an-ip'), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '999.1.1.1'), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1,'), '127.0.0.1');
});

test('clientAddress: IPv6 private peers are trusted proxies', () => {
  assert.equal(clientAddress('fd12:3456::1', '4.4.4.4'), '4.4.4.4');
  assert.equal(clientAddress('fe80::1%eth0', '4.4.4.4'), '4.4.4.4');
  assert.equal(clientAddress('2001:db8::1', '4.4.4.4'), '2001:db8::1');
});

test('clientAddress: empty values', () => {
  assert.equal(clientAddress('', ''), 'unknown');
  assert.equal(clientAddress(undefined, undefined), 'unknown');
  assert.equal(clientAddress('127.0.0.1', ''), '127.0.0.1');
  assert.equal(clientAddress(undefined, '1.1.1.1'), 'unknown');
});

test('isPrivateOrLoopback ranges', () => {
  for (const ip of ['127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '::1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1']) {
    assert.equal(isPrivateOrLoopback(ip), true, ip);
  }
  for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', '2001:db8::1', 'fec0::1', '::', '', 'junk']) {
    assert.equal(isPrivateOrLoopback(ip), false, ip);
  }
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
