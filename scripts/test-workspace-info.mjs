#!/usr/bin/env node
/**
 * Tests for the Workspace API additions in lib/workspace-fs.ts: tail and range reads (UTF-8 boundaries),
 * file info (magic numbers), download headers, and the save script's conflict check, run with the local
 * `sh` against a temp dir. No Docker, no network.
 *
 *   node scripts/test-workspace-info.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

await test('detectFileLabel: the magic-number table', () => {
  const tar = Buffer.alloc(512);
  tar.write('ustar', 257, 'latin1');
  const mp4 = bytes([0, 0, 0, 0x20], 'ftypisom');
  const webp = bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ');
  const table = [
    [bytes('SQLite format 3\0', [0x10, 0]), 'a.db', 'SQLite database'],
    [bytes([0x50, 0x4b, 3, 4, 0]), 'a.zip', 'ZIP archive'],
    [bytes([0x50, 0x4b, 5, 6, 0]), 'empty.zip', 'ZIP archive'],
    [bytes([0x50, 0x4b, 3, 4, 0]), 'Report.DOCX', 'ZIP (Office document)'],
    [bytes([0x50, 0x4b, 3, 4, 0]), 'sheet.xlsx', 'ZIP (Office document)'],
    [bytes([0x50, 0x4b, 3, 4, 0]), 'deck.pptx', 'ZIP (Office document)'],
    [bytes([0x1f, 0x8b, 8, 0]), 'a.gz', 'gzip archive'],
    [tar, 'a.tar', 'tar archive'],
    [bytes('%PDF-1.7\n'), 'a.pdf', 'PDF document'],
    [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'a.png', 'PNG image'],
    [bytes([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg', 'JPEG image'],
    [bytes('GIF89a', [1, 0]), 'a.gif', 'GIF image'],
    [bytes('GIF87a', [1, 0]), 'a.gif', 'GIF image'],
    [webp, 'a.webp', 'WebP image'],
    [bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1]), 'prog', 'ELF executable'],
    [bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), 'a.wasm', 'WebAssembly module'],
    [mp4, 'a.mp4', 'MP4 video'],
    [bytes('ID3', [4, 0]), 'a.mp3', 'MP3 audio'],
  ];
  for (const [data, name, label] of table) assert.equal(m.detectFileLabel(data, name), label, name);
  for (const none of [bytes('plain text\n'), bytes([0, 1, 2, 3]), bytes('PK'), bytes('RIFF....WAVE'), Buffer.alloc(0)]) {
    assert.equal(m.detectFileLabel(none, 'x.bin'), undefined);
  }
});

await test('describeFile: empty, text, binary (NUL, invalid UTF-8), labels', () => {
  assert.deepEqual(m.describeFile('', 'a.txt', 0), { kind: 'empty' });
  assert.deepEqual(m.describeFile(b64('héllo\n'), 'a.txt', 7), { kind: 'text' });
  assert.deepEqual(m.describeFile(b64(Buffer.from([0x61, 0, 0x62])), 'a.dat', 3), { kind: 'binary' });
  assert.deepEqual(m.describeFile(b64(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'a.txt', 4), { kind: 'binary' });
  assert.deepEqual(m.describeFile(b64(bytes('SQLite format 3\0', [0, 1, 2])), 'a.db', 216), { kind: 'binary', label: 'SQLite database' });
  assert.deepEqual(m.describeFile(b64(bytes('%PDF-1.4\n%abc')), 'a.pdf', 5000), { kind: 'text', label: 'PDF document' });
  // A character cut by the end of the 4 KiB sample, in a bigger file, is not a reason for "binary".
  const euro = Buffer.from('€');
  const sample = Buffer.concat([Buffer.from('a'.repeat(4094)), euro.subarray(0, 2)]);
  assert.deepEqual(m.describeFile(b64(sample), 'a.txt', 9000), { kind: 'text' });
  // Cut at the very end of the file it is invalid.
  assert.deepEqual(m.describeFile(b64(sample), 'a.txt', 4096), { kind: 'binary' });
});

await test('decodeWindow: a tail read drops a partial leading character', () => {
  const full = Buffer.from('xé€\u{1f600}end', 'utf8'); // 1 + 2 + 3 + 4 + 3 = 13 bytes
  assert.equal(full.length, 13);
  for (let n = 1; n <= full.length; n += 1) {
    const w = m.decodeWindow(b64(full.subarray(full.length - n)), null, full.length);
    assert.ok(w, `tail ${n}`);
    assert.equal(w.offset + w.length, full.length, `tail ${n}: ends at the end`);
    assert.equal(full.subarray(w.offset, w.offset + w.length).toString('utf8'), w.content, `tail ${n}: content matches its bytes`);
    assert.ok(w.offset - (full.length - n) <= 3);
  }
  // 5 bytes back lands inside the 4-byte emoji (bytes 6..9): the 'end' is bytes 10..12, 3 bytes + the last emoji byte.
  const w = m.decodeWindow(b64(full.subarray(9)), null, 13);
  assert.deepEqual(w, { content: 'end', offset: 10, length: 3 });
});

await test('decodeWindow: a range read drops partial characters at both ends', () => {
  const full = Buffer.from('ab€€yz', 'utf8'); // a b [e2 82 ac] [e2 82 ac] y z = 10 bytes
  // bytes 3..7 = 82 ac e2 82 ac: a leading continuation pair, one whole euro
  let w = m.decodeWindow(b64(full.subarray(3, 8)), 3, 10);
  assert.deepEqual(w, { content: '€', offset: 5, length: 3 });
  // bytes 1..6 = b e2 82 ac e2 82: a trailing partial euro
  w = m.decodeWindow(b64(full.subarray(1, 7)), 1, 10);
  assert.deepEqual(w, { content: 'b€', offset: 1, length: 4 });
  // both at once: bytes 4..6 = ac e2 82
  w = m.decodeWindow(b64(full.subarray(4, 7)), 4, 10);
  assert.equal(w.content, '');
  assert.equal(w.length, 0);
  // a window that starts at 0 keeps everything; one that ends at the end keeps a clean end
  w = m.decodeWindow(b64(full), 0, 10);
  assert.deepEqual(w, { content: 'ab€€yz', offset: 0, length: 10 });
  // reading backwards in chunks reproduces the file without gaps or overlaps
  let end = full.length;
  let text = '';
  while (end > 0) {
    const start = Math.max(0, end - 4);
    const win = m.decodeWindow(b64(full.subarray(start, end)), start, full.length);
    assert.ok(win);
    assert.equal(win.offset + win.length, end, 'a chunk that ends on a boundary keeps its end');
    text = win.content + text;
    end = win.offset;
  }
  assert.equal(text, full.toString('utf8'));
});

await test('decodeWindow: a partial character at the end of the file is invalid, as are bad bytes inside', () => {
  const euro = Buffer.from('€');
  assert.equal(m.decodeWindow(b64(Buffer.concat([Buffer.from('ab'), euro.subarray(0, 2)])), 0, 4), null);
  assert.equal(m.decodeWindow(b64(Buffer.from([0x61, 0xff, 0x62])), 0, 3), null);
  assert.deepEqual(m.decodeWindow('', 0, 0), { content: '', offset: 0, length: 0 });
  // more than three stray continuation bytes at the start are not "one partial character"
  assert.equal(m.decodeWindow(b64(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x61])), 10, 20), null);
});

await test('tailArgv and rangeArgv: constant scripts, the path one element, no request data in the text', () => {
  const nasty = `${ROOT}/a $(touch /tmp/pwn) 'q' "d"\nx;rm -rf.log`;
  for (const argv of [m.tailArgv(nasty, 1000), m.rangeArgv(nasty, 5, 200), m.tailArgv('-rf', 1)]) {
    assert.equal(argv[0], 'sh');
    assert.equal(argv[1], '-c');
    assert.equal(argv[3], 'sh');
    for (const a of argv.slice(4)) assert.equal(typeof a, 'string');
  }
  assert.equal(m.tailArgv(nasty, 1000).filter((a) => a === nasty).length, 1);
  assert.equal(m.rangeArgv(nasty, 5, 200).filter((a) => a === nasty).length, 1);
  assert.equal(m.tailArgv(nasty, 1)[2], m.TAIL_SCRIPT);
  assert.equal(m.tailArgv('/x', 99)[2], m.TAIL_SCRIPT);
  assert.equal(m.rangeArgv(nasty, 1, 1)[2], m.RANGE_SCRIPT);
  assert.deepEqual(m.rangeArgv('/x', 0, 4096), ['sh', '-c', m.RANGE_SCRIPT, 'sh', '+1', '/x', '4096']);
  assert.deepEqual(m.tailArgv('/x', 262144), ['sh', '-c', m.TAIL_SCRIPT, 'sh', '262144', '/x']);
  for (const script of [m.TAIL_SCRIPT, m.RANGE_SCRIPT]) assert.ok(!/pwn|\/x|\d{3}/.test(script), script);
});

await test('the tail and range scripts, run with sh, return the right bytes as base64', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-info-'));
  try {
    const file = path.join(tmp, '-odd name $x.log');
    const data = Buffer.from('0123456789€ABC\n', 'utf8');
    fs.writeFileSync(file, data);
    // The container has GNU stat. On a host whose stat has no -c (macOS), a shim answers -c %s / %Y.
    let env = process.env;
    if (spawnSync('stat', ['-c', '%s', '--', file]).status !== 0) {
      const shim = path.join(tmp, 'bin');
      fs.mkdirSync(shim);
      fs.writeFileSync(path.join(shim, 'stat'), '#!/bin/sh\n[ "$1" = -c ] && [ "$3" = -- ] || exit 1\ncase "$2" in %s) exec /usr/bin/stat -f %z "$4";; %Y) exec /usr/bin/stat -f %m "$4";; esac\nexit 1\n', { mode: 0o755 });
      env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
    }
    const exec = (argv) => spawnSync('sh', argv.slice(1), { encoding: 'utf8', env });
    const run = (argv) => {
      const r = exec(argv);
      assert.equal(r.status, 0, r.stderr);
      const sized = m.splitSizedOutput(r.stdout);
      assert.ok(sized, 'size line first');
      assert.equal(sized.size, data.length, 'the size comes with the bytes');
      return Buffer.from(sized.base64, 'base64');
    };
    assert.deepEqual(run(m.tailArgv(file, 5)), data.subarray(data.length - 5));
    assert.deepEqual(run(m.tailArgv(file, 5000)), data);
    assert.deepEqual(run(m.rangeArgv(file, 3, 6)), data.subarray(3, 9));
    assert.deepEqual(run(m.rangeArgv(file, 0, 4096)), data);
    assert.equal(run(m.rangeArgv(file, 500, 10)).length, 0);
    const win = m.decodeWindow(m.splitSizedOutput(exec(m.rangeArgv(file, 11, 4)).stdout).base64, 11, data.length);
    const gone = exec(m.tailArgv(path.join(tmp, 'missing.log'), 10));
    assert.equal(gone.status, 4, 'a missing file is an error, not empty content');
    assert.match(gone.stderr, /No such file or directory/);
    assert.equal(win.content.startsWith('€'), false, 'offset 11 is inside the euro sign: the partial start is dropped');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('parseWholeNumber accepts digits only', () => {
  assert.equal(m.parseWholeNumber('0'), 0);
  assert.equal(m.parseWholeNumber('262144'), 262144);
  for (const bad of [null, '', '-1', '1.5', '1e3', ' 1', '0x10', '+1', '1234567890123456']) assert.equal(m.parseWholeNumber(bad), null, String(bad));
  assert.equal(m.MAX_WINDOW_BYTES, 2 * 1024 * 1024);
  assert.equal(m.DEFAULT_TAIL_BYTES, 262144);
});

await test('downloadHeaders: an attachment of opaque bytes', () => {
  const h = m.downloadHeaders(`${ROOT}/a/naïve 'q'(1).png`, 99);
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.equal(h['Content-Length'], '99');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Cache-Control'], 'no-store');
  assert.equal(h['Content-Disposition'], "attachment; filename*=UTF-8''na%C3%AFve%20%27q%27%281%29.png");
  assert.equal(h['Content-Security-Policy'], undefined);
});

await test('the save script with an expected mtime: same writes, different refuses and touches nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-conflict-'));
  try {
    const file = path.join(tmp, 'note.md');
    fs.writeFileSync(file, 'agent version');
    const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000);
    // The container has GNU stat. On a host whose stat has no -c (macOS), a shim answers `stat -c %Y -- <file>`.
    let env = process.env;
    if (spawnSync('stat', ['-c', '%Y', '--', file]).status !== 0) {
      const shim = path.join(tmp, 'bin');
      fs.mkdirSync(shim);
      fs.writeFileSync(path.join(shim, 'stat'), '#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %Y ] && [ "$3" = -- ] && exec /usr/bin/stat -f %m "$4"\nexit 1\n', { mode: 0o755 });
      env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
    }
    const save = (expected, content) => spawnSync('sh', m.writeArgv(file, expected).slice(1), { input: content, env });

    // Different mtime: exit 23, the file is untouched, no temp file is left.
    let r = save(seconds - 5, 'my version');
    assert.equal(r.status, m.WRITE_EXIT_CONFLICT, String(r.stderr));
    assert.equal(fs.readFileSync(file, 'utf8'), 'agent version');
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n !== 'bin'), ['note.md']);

    // Same mtime: written.
    r = save(seconds, 'my version');
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(fs.readFileSync(file, 'utf8'), 'my version');

    // Without an expected mtime: as before, always written.
    r = save(undefined, 'forced');
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'forced');

    // The agent deleted the file after it was opened: with an expected mtime that is a conflict, nothing is created.
    const gone = path.join(tmp, 'deleted.md');
    r = spawnSync('sh', m.writeArgv(gone, 123).slice(1), { input: 'created', env });
    assert.equal(r.status, m.WRITE_EXIT_CONFLICT);
    assert.equal(fs.existsSync(gone), false);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('.rev4a-save')), [], 'no temp file left');
    // Without an expected mtime a new file is created, as before.
    r = spawnSync('sh', m.writeArgv(gone).slice(1), { input: 'created', env });
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(fs.readFileSync(gone, 'utf8'), 'created');

    // The expected value is an argument, not script text.
    assert.equal(m.writeArgv(file, 5)[2], m.WRITE_SCRIPT);
    assert.deepEqual(m.writeArgv(file, 5).slice(3), ['sh', file, '5']);
    assert.deepEqual(m.writeArgv(file).slice(3), ['sh', file]);
    // The mtime the stat script compares is the one statArgv reports.
    const st = spawnSync('stat', ['-c', '%Y', '--', file], { encoding: 'utf8' });
    if (st.status === 0) assert.equal(Number(st.stdout.trim()), Math.floor(fs.statSync(file).mtimeMs / 1000));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
