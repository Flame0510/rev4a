import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// lib/utils/format.ts imports '@/lib/timezone' (Next's alias); this hook gives plain Node the same view.
const root = pathToFileURL(import.meta.dirname + '/../').href;
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(root)};
const tryExt = (p) => { for (const e of ['.ts', '.js']) if (existsSync(p + e)) return p + e; return null; };
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const p = tryExt(new URL(specifier.slice(2), root).pathname);
    if (p) return next(pathToFileURL(p).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));

const s = await import('../lib/rev4a-settings.ts');
const tz = await import('../lib/timezone.ts');
const fmt = await import('../lib/utils/format.ts');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-settings-'));

test('validation: IANA names pass, everything else fails', () => {
  for (const v of ['Europe/Rome', 'UTC', 'America/New_York', 'Asia/Kolkata']) assert.equal(s.isValidTimezone(v), true, v);
  for (const v of ['', 'Rome', 'Europe/Nowhere', '../etc', null, undefined, 5, {}, ['UTC']]) assert.equal(s.isValidTimezone(v), false, String(v));
});

test('default: nothing saved reads as the server zone', () => {
  const dir = tmp();
  const r = s.readTimezone(dir, path.join(dir, 'no-legacy.json'));
  assert.equal(r.source, 'server');
  assert.equal(r.timezone, s.serverTimezone());
  assert.ok(s.isValidTimezone(r.timezone));
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'a read writes nothing');
});

test('write then read, atomic (no temp file left), other keys kept', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1 }));
  s.writeTimezone(dir, 'Asia/Tokyo');
  assert.deepEqual(s.readTimezone(dir, path.join(dir, 'x')), { timezone: 'Asia/Tokyo', source: 'saved' });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).other, 1);
});

test('write creates a missing directory', () => {
  const dir = path.join(tmp(), 'nested', 'data');
  s.writeTimezone(dir, 'UTC');
  assert.equal(s.readSettings(dir, path.join(dir, 'x')).timezone, 'UTC');
});

test('invalid or corrupt file reads as nothing saved', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  for (const content of ['not json', '[]', '{"timezone":"Nowhere/Land"}', '{"timezone":5}']) {
    fs.writeFileSync(file, content);
    assert.deepEqual(s.readSettings(dir, path.join(dir, 'x')), {}, content);
  }
});

test('import from the old file when the new one is absent', () => {
  const dir = tmp();
  const legacy = path.join(tmp(), 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ timezone: 'America/Chicago' }));
  assert.deepEqual(s.readTimezone(dir, legacy), { timezone: 'America/Chicago', source: 'saved' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).timezone, 'America/Chicago');
  assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf-8')).timezone, 'America/Chicago', 'old file untouched');
});

test('import never overrides the new file, and ignores absent or invalid old files', () => {
  const dir = tmp();
  const legacy = path.join(tmp(), 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ timezone: 'America/Chicago' }));
  s.writeTimezone(dir, 'Europe/Paris');
  assert.equal(s.readTimezone(dir, legacy).timezone, 'Europe/Paris');
  for (const [i, content] of [null, 'garbage', '{"timezone":"Nope/Nope"}'].entries()) {
    const d = tmp();
    const l = path.join(tmp(), `l${i}.json`);
    if (content !== null) fs.writeFileSync(l, content);
    assert.equal(s.readTimezone(d, l).source, 'server', String(content));
    assert.equal(fs.existsSync(path.join(d, 'settings.json')), false);
  }
});

test('import into an unwritable place does not throw', () => {
  const blocker = path.join(tmp(), 'file');
  fs.writeFileSync(blocker, 'x');
  const legacy = path.join(tmp(), 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ timezone: 'Asia/Dubai' }));
  assert.equal(s.readTimezone(path.join(blocker, 'sub'), legacy).source, 'server');
});

test('reset: clearTimezone forgets the zone and keeps other keys', () => {
  const dir = tmp();
  const none = path.join(dir, 'x');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1 }));
  s.writeTimezone(dir, 'Asia/Tokyo');
  s.clearTimezone(dir);
  assert.equal(s.readTimezone(dir, none, undefined).source, 'server');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')), { other: 1 });
});

test('reset: a cleared zone is not brought back by the legacy import', () => {
  const dir = tmp();
  const legacy = path.join(tmp(), 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ timezone: 'America/Chicago' }));
  s.writeTimezone(dir, 'Asia/Tokyo');
  s.clearTimezone(dir);
  assert.equal(s.readTimezone(dir, legacy, undefined).source, 'server');
});

test('resolution order: saved, then REV4A_TIMEZONE, then the server zone', () => {
  const dir = tmp();
  const none = path.join(dir, 'x');
  assert.deepEqual(s.readTimezone(dir, none, 'Asia/Dubai'), { timezone: 'Asia/Dubai', source: 'env' });
  assert.equal(s.readTimezone(dir, none, 'Nope/Nope').source, 'server');
  assert.equal(s.readTimezone(dir, none, '').source, 'server');
  s.writeTimezone(dir, 'Asia/Tokyo');
  assert.deepEqual(s.readTimezone(dir, none, 'Asia/Dubai'), { timezone: 'Asia/Tokyo', source: 'saved' });
});

test('canonical spelling is stored: europe/rome, utc', () => {
  assert.equal(s.canonicalTimezone('europe/rome'), 'Europe/Rome');
  assert.equal(s.canonicalTimezone('utc'), 'UTC');
  assert.equal(s.canonicalTimezone('Mars/Base'), null);
  assert.equal(s.canonicalTimezone('+01:00'), null);
  const dir = tmp();
  assert.equal(s.writeTimezone(dir, 'europe/rome'), 'Europe/Rome');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).timezone, 'Europe/Rome');
  assert.throws(() => s.writeTimezone(dir, 'Mars/Base'));
});

test('reset before any read: the legacy zone is not imported afterwards', () => {
  const dir = tmp();
  const legacy = path.join(tmp(), 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ timezone: 'America/Chicago' }));
  s.clearTimezone(dir); // no new file yet
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), true);
  assert.equal(s.readTimezone(dir, legacy, undefined).source, 'server');
});

test('client: an unknown zone never reaches Intl, it falls back', () => {
  assert.equal(tz.normalizeRev4aTimezone('Mars/Base'), tz.fallbackRev4aTimezone());
  assert.equal(tz.normalizeRev4aTimezone(''), tz.fallbackRev4aTimezone());
  assert.equal(tz.normalizeRev4aTimezone('Asia/Tokyo'), 'Asia/Tokyo');
  assert.doesNotThrow(() => tz.formatDateTimeInTimezone(0, {}, 'Mars/Base'));
  assert.doesNotThrow(() => fmt.formatTimeFromUnixSeconds(0));
});

await (async () => {
  // A failing /api/settings is asked for once, then not again until the back-off is over.
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401 }; };
  globalThis.window = {};
  try {
    // cache is null here (the cache tests come after this block)
    for (let i = 0; i < 5; i++) fmt.getTimeZone();
    await tz.fetchRev4aTimezone();
    for (let i = 0; i < 5; i++) { fmt.getTimeZone(); await tz.fetchRev4aTimezone(); }
    test('failed fetch: one request, then back-off (no request per render)', () => assert.equal(calls, 1));
    test('failed fetch: every caller gets the same fallback', () => assert.equal(fmt.getTimeZone(), tz.fallbackRev4aTimezone()));
  } finally {
    globalThis.fetch = realFetch;
    if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
  }
})();

test('client cache: update notifies subscribers until they unsubscribe', () => {
  const seen = [];
  const off = tz.subscribeRev4aTimezone((z) => seen.push(z));
  assert.equal(tz.getCachedRev4aTimezone(), null);
  tz.updateCachedRev4aTimezone('Asia/Tokyo');
  assert.equal(tz.getCachedRev4aTimezone(), 'Asia/Tokyo');
  off();
  tz.updateCachedRev4aTimezone('UTC');
  assert.deepEqual(seen, ['Asia/Tokyo']);
});

test('format.ts follows the cached setting, not a hard-coded zone', () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;
  tz.updateCachedRev4aTimezone('Asia/Tokyo');
  assert.equal(fmt.getTimeZone(), 'Asia/Tokyo');
  assert.equal(fmt.formatTimeFromUnixSeconds(ts), '21:00:00');
  tz.updateCachedRev4aTimezone('America/New_York');
  assert.equal(fmt.formatTimeFromUnixSeconds(ts), '07:00:00');
  fmt.setTimeZone('UTC');
  assert.equal(fmt.formatTimeFromUnixSeconds(ts), '12:00:00');
  fmt.setTimeZone(null);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall ok');
