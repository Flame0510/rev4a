#!/usr/bin/env node
/**
 * Tests for the raw (media) mode helpers in lib/workspace-fs.ts: content types, headers,
 * timeout and size bounds. No Docker, no network.
 *
 *   node scripts/test-workspace-media.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../lib/workspace-fs.ts');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}\n`, e);
    process.exit(1);
  }
}

const ROOT = '/root/.openclaw/workspace';

await test('rawContentType maps every served extension', () => {
  const expected = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
    flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
    mov: 'video/quicktime', ogv: 'video/ogg',
  };
  for (const [ext, type] of Object.entries(expected)) {
    assert.equal(m.rawContentType(`${ROOT}/a/file.${ext}`), type, ext);
  }
  assert.equal(Object.keys(m.RAW_TYPES).length, Object.keys(expected).length);
});

await test('rawContentType ignores case and looks at the last extension', () => {
  assert.equal(m.rawContentType(`${ROOT}/LOGO.PNG`), 'image/png');
  assert.equal(m.rawContentType(`${ROOT}/Doc.Pdf`), 'application/pdf');
  assert.equal(m.rawContentType(`${ROOT}/a.tar.png`), 'image/png');
  assert.equal(m.rawContentType(`${ROOT}/a.png.txt`), null);
});

await test('rawContentType refuses everything else', () => {
  for (const p of ['.env', 'a.env', 'x.html', 'x.htm', 'x.svgz', 'x.js', 'x.json', 'x.txt', 'x.xml', 'noext', 'x.', 'x.constructor', 'x.__proto__', 'x.toString', 'x.png ']) {
    assert.equal(m.rawContentType(`${ROOT}/${p}`), null, p);
  }
  assert.equal(m.rawContentType(`${ROOT}/dir.png/secret`), null);
});

await test('rawHeaders: the fixed headers', () => {
  const h = m.rawHeaders(`${ROOT}/a/pic.png`, 1234);
  assert.equal(h['Content-Type'], 'image/png');
  assert.equal(h['Content-Length'], '1234');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Cache-Control'], 'no-store');
  assert.equal(h['Content-Disposition'], "inline; filename*=UTF-8''pic.png");
  assert.equal(h['Content-Security-Policy'], undefined);
});

await test('rawHeaders: CSP only for svg', () => {
  const svg = m.rawHeaders(`${ROOT}/i.SVG`, 10);
  assert.equal(svg['Content-Type'], 'image/svg+xml');
  assert.equal(svg['Content-Security-Policy'], "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  for (const p of ['a.pdf', 'a.mp4', 'a.jpg']) assert.equal(m.rawHeaders(`${ROOT}/${p}`, 1)['Content-Security-Policy'], undefined, p);
});

await test('rawHeaders: file names are encoded', () => {
  const cd = (name) => m.rawHeaders(`${ROOT}/${name}`, 1)['Content-Disposition'];
  assert.equal(cd('my photo.png'), "inline; filename*=UTF-8''my%20photo.png");
  assert.equal(cd('a"b\'c.png'), "inline; filename*=UTF-8''a%22b%27c.png");
  assert.equal(cd('città.png'), "inline; filename*=UTF-8''citt%C3%A0.png");
  assert.equal(cd('x(1)*.png'), "inline; filename*=UTF-8''x%281%29%2A.png");
  assert.ok(!/[\r\n]/.test(cd('a\r\nSet-Cookie: x.png')));
  assert.equal(m.rawHeaders(`${ROOT}/x.unknown`, 1)['Content-Type'], 'application/octet-stream');
});

await test('rawTimeoutMs scales with size and is bounded', () => {
  assert.equal(m.rawTimeoutMs(0), 15_000);
  assert.equal(m.rawTimeoutMs(-5), 15_000);
  assert.equal(m.rawTimeoutMs(1), 16_000);
  assert.equal(m.rawTimeoutMs(10 * 1024 * 1024), 25_000);
  assert.equal(m.rawTimeoutMs(m.MAX_RAW_BYTES), 65_000);
  assert.equal(m.rawTimeoutMs(10 * m.MAX_RAW_BYTES), 90_000);
});

await test('size cap and buffer', () => {
  assert.equal(m.MAX_RAW_BYTES, 50 * 1024 * 1024);
  assert.ok(m.RAW_MAX_BUFFER > Math.ceil((m.MAX_RAW_BYTES * 4) / 3));
});

console.log('all passed');
