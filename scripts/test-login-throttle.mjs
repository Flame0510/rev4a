import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoginThrottle } = require('../lib/login-throttle.js');
const { clientAddress, isPrivateOrLoopback, parseTrustedProxies, throttleKey } = require('../lib/client-address.js');

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

/** The route's flow: check, fail only when allowed; the clock jumps to each unlock. Returns attempt times. */
function patientAttacker(th, key, hours) {
  const attempts = [];
  const end = t + hours * 60 * MIN;
  while (t < end) {
    const gate = th.check(key);
    if (!gate.allowed) { t += gate.retryAfterS * S; continue; }
    th.fail(key);
    attempts.push(t - 1_800_000_000_000);
    t += 1;
  }
  return attempts;
}

test('the lock is capped at 15 minutes (real route flow)', () => {
  const th = fresh();
  let longest = 0;
  for (let i = 0; i < 40; i++) {
    const gate = th.check('a');
    if (!gate.allowed) { t += gate.retryAfterS * S; i--; continue; }
    th.fail('a');
    const after = th.check('a');
    if (!after.allowed) longest = Math.max(longest, after.retryAfterS);
    t += 1;
  }
  assert.equal(longest, 900);
});

test('a patient attacker retrying at every unlock gets at most 5 attempts an hour after the first hour', () => {
  const th = fresh();
  const attempts = patientAttacker(th, 'a', 6);
  const perHour = [0, 0, 0, 0, 0, 0];
  for (const a of attempts) perHour[Math.floor(a / (60 * MIN))]++;
  for (let h = 1; h < 6; h++) assert.ok(perHour[h] <= 5, `hour ${h}: ${perHour[h]} attempts (${perHour})`);
  assert.ok(perHour[0] <= 14, `first hour: ${perHour[0]}`);
  // The cap is reached: the last lock handed out is 900 s.
  th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: false, retryAfterS: 900 });
});

test('a key that stays quiet for a whole window starts again from zero', () => {
  const th = fresh();
  patientAttacker(th, 'a', 2);
  t += 61 * MIN;
  assert.deepEqual(th.check('a'), { allowed: true });
  assert.equal(th.size(), 0);
  for (let i = 0; i < 5; i++) th.fail('a');
  assert.deepEqual(th.check('a'), { allowed: true });
});

test('an occasional wrong password is never locked', () => {
  const th = fresh();
  for (let i = 0; i < 50; i++) { th.fail('a'); assert.deepEqual(th.check('a'), { allowed: true }); t += 50 * MIN; }
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
  t += 60 * MIN;
  th.fail('a'); // would be the 6th without the window
  assert.deepEqual(th.check('a'), { allowed: true });
  assert.equal(th.size(), 1);
  t += 60 * MIN;
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

test('eviction never frees a locked key while an unlocked one exists', () => {
  const th = fresh({ maxKeys: 3 });
  for (let i = 0; i < 6; i++) th.fail('locked'); // oldest entry, and locked
  for (let i = 0; i < 20; i++) { t += 1; th.fail(`u${i}`); }
  assert.equal(th.size(), 3);
  assert.equal(th.check('locked').allowed, false);
});

test('eviction with every key locked removes the lock that ends soonest', () => {
  const th = fresh({ maxKeys: 3 });
  for (let i = 0; i < 6; i++) th.fail('short'); // 30 s
  for (const k of ['b', 'c']) { for (let i = 0; i < 8; i++) th.fail(k); } // 120 s
  th.fail('d');
  assert.equal(th.size(), 3);
  assert.deepEqual(th.check('short'), { allowed: true }); // evicted
  assert.equal(th.check('b').allowed, false);
  assert.equal(th.check('c').allowed, false);
});

test('clientAddress: public peer ignores a spoofed X-Forwarded-For', () => {
  assert.equal(clientAddress('8.8.8.8', '1.1.1.1'), '8.8.8.8');
  assert.equal(clientAddress('::ffff:8.8.4.4', '1.1.1.1, 2.2.2.2'), '8.8.4.4');
});

const LOOP = parseTrustedProxies('127.0.0.0/8,::1');

test('clientAddress: a loopback peer is the key unless listed', () => {
  assert.equal(clientAddress('127.0.0.1', '6.6.6.6'), '127.0.0.1');
  assert.equal(clientAddress('::ffff:127.0.0.1', '6.6.6.6'), '127.0.0.1');
  assert.equal(clientAddress('::1', '6.6.6.6'), '::/64');
  assert.equal(clientAddress('127.0.0.1', '6.6.6.6', parseTrustedProxies('')), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '6.6.6.6', parseTrustedProxies('192.0.2.10')), '127.0.0.1');
});

test('clientAddress: loopback listed in REV4A_TRUSTED_PROXIES uses the rightmost entry', () => {
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, 2.2.2.2', LOOP), '2.2.2.2');
  assert.equal(clientAddress('::1', '2.2.2.2', LOOP), '2.2.2.2');
  assert.equal(clientAddress('127.0.0.1', ' 2.2.2.2 ', LOOP), '2.2.2.2');
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, 2001:DB8::1', LOOP), '2001:db8::/64');
  assert.equal(clientAddress('127.255.0.9', '2.2.2.2', LOOP), '2.2.2.2');
});

test('clientAddress: an IPv4-mapped loopback peer matches a listed 127.0.0.1', () => {
  assert.equal(clientAddress('::ffff:127.0.0.1', '3.3.3.3', parseTrustedProxies('127.0.0.1')), '3.3.3.3');
  assert.equal(clientAddress('::ffff:127.0.0.1', undefined, LOOP), '127.0.0.1');
});

test('clientAddress: a malformed rightmost entry falls back to the socket address', () => {
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1, not-an-ip', LOOP), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '999.1.1.1', LOOP), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '1.1.1.1,', LOOP), '127.0.0.1');
});

test('clientAddress: private peers are not trusted (agent containers, LAN clients)', () => {
  assert.equal(clientAddress('192.168.1.10', '6.6.6.6'), '192.168.1.10');
  assert.equal(clientAddress('172.18.0.3', '6.6.6.6'), '172.18.0.3');
  assert.equal(clientAddress('10.0.0.5', '6.6.6.6'), '10.0.0.5');
  assert.equal(clientAddress('fd12:3456::1', '4.4.4.4'), 'fd12:3456::/64');
  assert.equal(clientAddress('fe80::1%eth0', '4.4.4.4'), 'fe80::/64');
  assert.equal(clientAddress('2001:db8::1', '4.4.4.4'), '2001:db8::/64');
});

test('REV4A_TRUSTED_PROXIES: listed addresses and CIDRs are trusted, others are not', () => {
  const trusted = parseTrustedProxies('172.18.0.5,10.0.0.0/24, fd00::/8 ,garbage,10.0.0.0/33,1.2.3.4/x,,fd00::1/129');
  assert.deepEqual(trusted.invalid, ['garbage', '10.0.0.0/33', '1.2.3.4/x', 'fd00::1/129']);
  assert.equal(trusted.size, 3);
  assert.equal(clientAddress('172.18.0.5', '6.6.6.6', trusted), '6.6.6.6');
  assert.equal(clientAddress('10.0.0.77', '6.6.6.6', trusted), '6.6.6.6');
  assert.equal(clientAddress('fd12::9', '6.6.6.6', trusted), '6.6.6.6');
  assert.equal(clientAddress('::ffff:172.18.0.5', '6.6.6.6', trusted), '6.6.6.6');
  assert.equal(clientAddress('172.18.0.6', '6.6.6.6', trusted), '172.18.0.6');
  assert.equal(clientAddress('10.0.1.1', '6.6.6.6', trusted), '10.0.1.1');
  assert.equal(clientAddress('127.0.0.1', '6.6.6.6', trusted), '127.0.0.1'); // loopback is not implicitly trusted
  assert.equal(clientAddress('192.168.1.10', '6.6.6.6', parseTrustedProxies('')), '192.168.1.10');
  assert.equal(parseTrustedProxies(undefined).size, 0);
  assert.equal(parseTrustedProxies('   ').invalid.length, 0);
});

test('REV4A_TRUSTED_PROXIES: very wide ranges are accepted and reported', () => {
  const t = parseTrustedProxies('0.0.0.0/0,::/0,10.0.0.0/7,10.0.0.0/8,fd00::/15,fd00::/16,192.0.2.10');
  assert.deepEqual(t.wide, ['0.0.0.0/0', '::/0', '10.0.0.0/7', 'fd00::/15']);
  assert.equal(t.size, 7);
  assert.equal(clientAddress('8.8.8.8', '6.6.6.6', t), '6.6.6.6');
  assert.deepEqual(parseTrustedProxies('192.0.2.10,10.0.0.0/24').wide, []);
});

test('IPv6 keys are the /64', () => {
  assert.equal(clientAddress('2001:db8:1:2:aaaa::1', ''), '2001:db8:1:2::/64');
  assert.equal(clientAddress('2001:db8:1:2:bbbb::9', ''), clientAddress('2001:db8:1:2:aaaa::1', ''));
  assert.notEqual(clientAddress('2001:db8:1:3::1', ''), clientAddress('2001:db8:1:2::1', ''));
  assert.equal(clientAddress('127.0.0.1', '2001:db8:1:2:3:4:5:6', LOOP), '2001:db8:1:2::/64');
  assert.equal(throttleKey('::1'), '::/64');
  assert.equal(throttleKey('2001:db8::5'), '2001:db8::/64');
  assert.equal(throttleKey('2001:db8:0:5::1'), '2001:db8:0:5::/64');
  assert.equal(throttleKey('::1.2.3.4'), '::/64');
  assert.equal(throttleKey('8.8.8.8'), '8.8.8.8');
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
