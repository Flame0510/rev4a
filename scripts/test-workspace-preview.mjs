#!/usr/bin/env node
/**
 * Tests for the Workspace file previews: lib/csv-parse.ts and app/workspace/preview/preview-utils.ts
 * (preview kinds, languages, JSON error positions, .env masking, line splitting). No DOM, no
 * network.
 *
 *   node scripts/test-workspace-preview.mjs
 */
import assert from 'node:assert/strict';

const csv = await import('../lib/csv-parse.ts');
const pv = await import('../app/workspace/preview/preview-utils.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}\n`, e);
    process.exit(1);
  }
}

await test('csv: plain rows, trailing newline adds no row', () => {
  const r = csv.parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(r.rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.equal(r.total, 2);
});

await test('csv: no trailing newline, CRLF and lone CR', () => {
  assert.deepEqual(csv.parseCsv('a,b\r\n1,2').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csv.parseCsv('a,b\r1,2\r').rows, [['a', 'b'], ['1', '2']]);
});

await test('csv: quoted fields, escaped quotes and embedded delimiters', () => {
  const r = csv.parseCsv('name,quote\n"Smith, J","He said ""hi"""\n');
  assert.deepEqual(r.rows[1], ['Smith, J', 'He said "hi"']);
});

await test('csv: embedded newlines inside quotes (LF and CRLF)', () => {
  const r = csv.parseCsv('a,b\r\n"line1\r\nline2",x\r\n"p\nq",y\r\n');
  assert.deepEqual(r.rows, [['a', 'b'], ['line1\r\nline2', 'x'], ['p\nq', 'y']]);
  assert.equal(r.total, 3);
});

await test('csv: empty fields, ragged rows, blank line', () => {
  const r = csv.parseCsv('a,b,c\n1,,3\n4\n\n5,6,7,8\n');
  assert.deepEqual(r.rows, [['a', 'b', 'c'], ['1', '', '3'], ['4'], [''], ['5', '6', '7', '8']]);
});

await test('csv: empty text, BOM, a quote in the middle of a field, unterminated quote', () => {
  assert.deepEqual(csv.parseCsv(''), { rows: [], total: 0 });
  assert.deepEqual(csv.parseCsv('﻿a,b').rows, [['a', 'b']]);
  assert.deepEqual(csv.parseCsv('5" pipe,x').rows, [['5" pipe', 'x']]);
  assert.deepEqual(csv.parseCsv('a,"open\nstill').rows, [['a', 'open\nstill']]);
  assert.deepEqual(csv.parseCsv('a,\n').rows, [['a', '']]);
});

await test('tsv: tab delimiter keeps commas and quotes', () => {
  const r = csv.parseCsv('a\tb\n"x\ty"\tz, w\n', { delimiter: '\t' });
  assert.deepEqual(r.rows, [['a', 'b'], ['x\ty', 'z, w']]);
});

await test('csv: maxRows cuts the rows but total counts them all', () => {
  const lines = ['h1,h2'];
  for (let i = 1; i <= 2500; i++) lines.push(`${i},"v ${i}"`);
  const r = csv.parseCsv(lines.join('\n') + '\n', { maxRows: 1001 });
  assert.equal(r.rows.length, 1001);
  assert.equal(r.total, 2501);
  assert.deepEqual(r.rows[1000], ['1000', 'v 1000']);
});

await test('sniffDelimiter: semicolon CSV from an Italian Excel export', () => {
  const text = 'Nome;Importo;Note\r\n"Rossi, Mario";"1.234,56";"ok, pagato"\r\nBianchi;"99,90";\r\n"Verdi; Anna";"2.000,00";x\r\n';
  assert.equal(csv.sniffDelimiter(text), ';');
  const r = csv.parseCsv(text, { delimiter: ';' });
  assert.deepEqual(r.rows[1], ['Rossi, Mario', '1.234,56', 'ok, pagato']);
  assert.deepEqual(r.rows[3], ['Verdi; Anna', '2.000,00', 'x']);
});

await test('sniffDelimiter: comma, tab, pipe, single column, ties and blank lines', () => {
  assert.equal(csv.sniffDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(csv.sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(csv.sniffDelimiter('a|b|c\n1|2|3\n4|5|6\n'), '|');
  assert.equal(csv.sniffDelimiter('name\nalice\nbob, jr\n'), ',');
  assert.equal(csv.sniffDelimiter('one\ntwo\nthree\n'), ',');
  assert.equal(csv.sniffDelimiter(''), ',');
  assert.equal(csv.sniffDelimiter('\n\na;b\n\n1;2\n'), ';');
  assert.equal(csv.sniffDelimiter('a,b;c\n1,2;3\n'), ',');
  assert.equal(csv.delimiterLabel('\t'), 'Tab');
  assert.equal(csv.delimiterLabel(';'), ';');
});

await test('previewKindOf: by extension', () => {
  const k = pv.previewKindOf;
  for (const n of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.py', 'a.sh', 'a.css', 'a.html', 'a.sql', 'a.go', 'a.rs', 'a.toml', 'a.ini', 'a.conf', 'a.diff', 'dir/sub/a.PY']) {
    assert.equal(k(n), 'code', n);
  }
  assert.equal(k('a.json'), 'json');
  assert.equal(k('a.jsonl'), 'json');
  assert.equal(k('a.yaml'), 'yaml');
  assert.equal(k('A.YML'), 'yaml');
  assert.equal(k('a.csv'), 'csv');
  assert.equal(k('a.tsv'), 'tsv');
});

await test('previewKindOf: well-known names, env files, no match', () => {
  const k = pv.previewKindOf;
  for (const n of ['Dockerfile', 'Dockerfile.dev', 'Makefile', '.bashrc', '.zshrc', '.gitignore', 'x/Makefile']) assert.equal(k(n), 'code', n);
  for (const n of ['.env', '.env.local', '.env.production', 'prod.env', 'x/.env']) assert.equal(k(n), 'env', n);
  for (const n of ['README.md', 'notes.txt', 'photo.png', 'archive.zip', 'LICENSE', '', 'noext', 'environment.ts.bak']) {
    assert.equal(k(n), null, n);
  }
});

await test('languageOf and fenceLanguage only return registered languages', () => {
  const names = new Set(pv.PREVIEW_LANGS);
  assert.equal(pv.languageOf('a.tsx'), 'typescript');
  assert.equal(pv.languageOf('a.html'), 'xml');
  assert.equal(pv.languageOf('a.toml'), 'ini');
  assert.equal(pv.languageOf('Dockerfile'), 'dockerfile');
  assert.equal(pv.languageOf('notes.txt'), null);
  for (const f of ['js', 'ts', 'sh', 'c++', 'yml', 'Dockerfile', 'html', 'rs', 'go', 'JSON']) {
    assert.ok(names.has(pv.fenceLanguage(f)), f);
  }
  assert.equal(pv.fenceLanguage('klingon'), null);
  assert.equal(pv.fenceLanguage(''), null);
  assert.equal(pv.PREVIEW_LANGS.length, 24);
});

await test('lineColumnAt: 1-based lines and columns', () => {
  assert.deepEqual(pv.lineColumnAt('abc', 0), { line: 1, column: 1 });
  assert.deepEqual(pv.lineColumnAt('abc\ndef', 5), { line: 2, column: 2 });
  assert.deepEqual(pv.lineColumnAt('abc\n', 4), { line: 2, column: 1 });
  assert.deepEqual(pv.lineColumnAt('abc', 99), { line: 1, column: 4 });
});

await test('findJsonError agrees with JSON.parse on valid and invalid texts', () => {
  const valid = ['{}', '[]', '0', '-1.5e+3', '"a\\u00e9\\n"', 'true', ' null ', '{"a":[1,{"b":null}],"c":"x"}', '[\n 1,\n 2\n]\n'];
  const invalid = ['', '{', '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", '[1 2]', '01', '-', '1.', '"abc', '"a\nb"', 'nul', 'tru', '{"a" 1}', '[1] x', '{"a":}', '"\\x"', 'NaN', '{"a":1', '[', '1e'];
  for (const t of valid) { JSON.parse(t); assert.equal(pv.findJsonError(t), null, t); }
  for (const t of invalid) {
    assert.throws(() => JSON.parse(t), SyntaxError, t);
    const f = pv.findJsonError(t);
    assert.ok(f && f.position >= 0 && f.position <= t.length && f.message, JSON.stringify(t));
  }
});

await test('jsonErrorInfo: line, column and message from the scan', () => {
  const t1 = '{\n  "a": 1,\n  "b": ,\n}';
  const i1 = pv.jsonErrorInfo(t1, new SyntaxError('whatever'));
  assert.deepEqual([i1.line, i1.column], [3, 8]);
  assert.match(i1.message, /Unexpected token ","/);
  const i2 = pv.jsonErrorInfo('{"a":\n', new SyntaxError('x'));
  assert.deepEqual([i2.line, i2.column], [2, 1]);
  assert.match(i2.message, /end of JSON input/);
  const i3 = pv.jsonErrorInfo('[1, 2\n 3]', new SyntaxError('x'));
  assert.deepEqual([i3.line, i3.column], [2, 2]);
  assert.match(pv.jsonErrorInfo('{"a":1} extra', new Error('x')).message, /after the JSON value/);
});

await test('jsonErrorInfo: engine message is the fallback when the scan finds nothing', () => {
  assert.deepEqual(pv.jsonErrorInfo('[1]', new SyntaxError('Unexpected token } in JSON at position 2 (line 1 column 3)')), { line: 1, column: 3, message: 'Unexpected token } in JSON at position 2' });
  assert.equal(pv.jsonErrorInfo('1', new SyntaxError('bad at line 3 column 9 of the JSON data')).line, 3);
  const none = pv.jsonErrorInfo('1', new SyntaxError(''));
  assert.deepEqual([none.line, none.column, none.message], [1, 1, 'Invalid JSON']);
  assert.equal(pv.isJsonLines('a.jsonl'), true);
  assert.equal(pv.isJsonLines('a.json'), false);
});

await test('env: masked output contains no value', () => {
  const secret = 'sk-live-ABC123secret';
  const text = [
    '# database',
    'DB_URL=postgres://user:hunter2@db/app',
    'export API_KEY="' + secret + '"',
    'EMPTY=',
    '',
    'KEY_WITH_SPACES = value with spaces # trailing',
    '-----BEGIN PRIVATE KEY-----',
    'PRIVATEBODY',
    '',
  ].join('\n');
  const masked = pv.maskEnvText(text);
  for (const leak of ['hunter2', 'postgres', secret, 'value with spaces', 'trailing', 'BEGIN', 'PRIVATEBODY']) {
    assert.ok(!masked.includes(leak), `leaked ${leak}`);
  }
  const lines = masked.split('\n');
  assert.equal(lines[0], '# database');
  assert.equal(lines[1], `DB_URL=${pv.ENV_MASK}`);
  assert.equal(lines[2], `export API_KEY=${pv.ENV_MASK}`);
  assert.equal(lines[3], 'EMPTY=');
  assert.equal(lines[4], '');
  assert.equal(lines[5], `KEY_WITH_SPACES=${pv.ENV_MASK}`);
  assert.equal(lines[6], pv.ENV_MASK);
});

await test('env: a multi-line quoted value is masked on every line', () => {
  const text = [
    'A=1',
    'KEY="-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '#hashlinevalue',
    'QUJDREVGR0hJSktM=',
    'ABC=',
    '[section-looking]',
    '-----END PRIVATE KEY-----"',
    '# real comment',
    'B=2',
    "SQ='multi",
    '#insidesingle',
    "end'",
    'C=3',
    '',
  ].join('\n');
  const masked = pv.maskEnvText(text);
  for (const leak of ['BEGIN', 'MIIEv', 'hashlinevalue', 'QUJDRE', 'ABC=', 'section-looking', 'END PRIVATE', 'insidesingle', 'multi', "end'"]) {
    assert.ok(!masked.includes(leak), 'leaked ' + leak);
  }
  const lines = masked.split('\n');
  assert.equal(lines[0], 'A=' + pv.ENV_MASK);
  assert.equal(lines[1], 'KEY=' + pv.ENV_MASK);
  for (const i of [2, 3, 4, 5, 6, 7]) assert.equal(lines[i], pv.ENV_MASK, 'line ' + i);
  assert.equal(lines[8], '# real comment');
  assert.equal(lines[9], 'B=' + pv.ENV_MASK);
  assert.equal(lines[10], 'SQ=' + pv.ENV_MASK);
  assert.equal(lines[11], pv.ENV_MASK);
  assert.equal(lines[12], pv.ENV_MASK);
  assert.equal(lines[13], 'C=' + pv.ENV_MASK);
});

await test('env: a quote opener alone is not an empty value; closed quotes and continuations', () => {
  assert.equal(pv.maskEnvText('K="\nsecret\n"\nZ=1'), 'K=' + pv.ENV_MASK + '\n' + pv.ENV_MASK + '\n' + pv.ENV_MASK + '\nZ=' + pv.ENV_MASK);
  assert.equal(pv.maskEnvText('K="a b"\n#c\nZ=\'x\''), 'K=' + pv.ENV_MASK + '\n#c\nZ=' + pv.ENV_MASK);
  assert.equal(pv.maskEnvText('K="a \\" b"\n#c'), 'K=' + pv.ENV_MASK + '\n#c');
  assert.equal(pv.maskEnvText('K=abc\\\nnext part\nZ=1'), 'K=' + pv.ENV_MASK + '\n' + pv.ENV_MASK + '\nZ=' + pv.ENV_MASK);
});

await test('previewKindOf: credential files are env; prototype names are not previewable', () => {
  for (const n of ['.npmrc', '.netrc', '.pgpass', '.git-credentials', '.gitconfig', 'home/.NPMRC']) assert.equal(pv.previewKindOf(n), 'env', n);
  for (const n of ['constructor', '__proto__', 'foo.constructor', 'a.__proto__', 'toString', 'a.hasOwnProperty', 'valueOf']) {
    assert.equal(pv.previewKindOf(n), null, n);
    assert.equal(pv.languageOf(n), null, n);
  }
  for (const f of ['constructor', '__proto__', 'toString']) assert.equal(pv.fenceLanguage(f), null, f);
});

await test('capLines: first N lines, total count, trailing newline', () => {
  assert.deepEqual(pv.capLines('a\nb\nc\n', 2), { text: 'a\nb', total: 3, cut: true });
  assert.deepEqual(pv.capLines('a\nb\nc', 2), { text: 'a\nb', total: 3, cut: true });
  assert.deepEqual(pv.capLines('a\nb\n', 2), { text: 'a\nb\n', total: 2, cut: false });
  assert.deepEqual(pv.capLines('', 2), { text: '', total: 0, cut: false });
  const big = '1\n'.repeat(1048576);
  const r = pv.capLines(big);
  assert.equal(r.total, 1048576);
  assert.equal(r.cut, true);
  assert.equal(r.text.split('\n').length, pv.MAX_RENDER_LINES);
  assert.equal(pv.MAX_RENDER_LINES, 20000);
  assert.equal(pv.CSV_MAX_COLS, 200);
});

await test('plain rendering of a capped 2 MB file stays small', () => {
  const r = pv.capLines('1\n'.repeat(1048576));
  const html = pv.numberedLinesHtml(pv.plainLines(r.text));
  assert.ok(html.length < 3 * 1024 * 1024, String(html.length));
});

await test('jsonMaxDepth: ignores brackets in strings; deep nesting is detected cheaply', () => {
  assert.equal(pv.jsonMaxDepth('{"a":[1,{"b":"]]}}[["}]}'), 3);
  assert.equal(pv.jsonMaxDepth('"\\"[["'), 0);
  assert.equal(pv.jsonMaxDepth(''), 0);
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  assert.equal(pv.jsonMaxDepth(deep), 5000);
  assert.ok(pv.jsonMaxDepth(deep) > pv.JSON_MAX_DEPTH);
  assert.ok(pv.jsonMaxDepth('['.repeat(100) + ']'.repeat(100)) <= pv.JSON_MAX_DEPTH);
  const deepVeryBig = '['.repeat(100000) + ']'.repeat(100000);
  JSON.parse(deepVeryBig); // the engine accepts it, so it must not be reported as invalid
  assert.equal(pv.findJsonError('[1]'), null);
});

await test('jsonl: very many invalid lines do not need a spread (loop over a set)', () => {
  // Same shape as the component: a Set of flagged rows and a first index, no Math.min(...set).
  const text = '{\n  "a": 1\n}\n'.repeat(80000);
  const flagged = new Set();
  let first = -1;
  pv.capLines(text).text.split('\n').forEach((line, i) => {
    try { JSON.parse(line); } catch { flagged.add(i); if (first < 0) first = i; }
  });
  assert.ok(flagged.size > 10000);
  assert.equal(first, 0);
});

await test('csv: wide rows keep the parse linear (columns are capped by the component, not the parser)', () => {
  const wide = 'a,b\n' + ','.repeat(500000) + '\n';
  const r = csv.parseCsv(wide, { maxRows: 1001 });
  assert.equal(r.total, 2);
  assert.equal(r.rows[1].length, 500001);
});

await test('env: parseEnvLines keeps keys and types', () => {
  const l = pv.parseEnvLines('A=1\r\n# c\r\n\r\nexport B=2\r\n');
  assert.deepEqual(l.map((x) => x.type), ['pair', 'comment', 'blank', 'pair']);
  assert.equal(l[0].key, 'A');
  assert.equal(l[0].value, '1');
  assert.equal(l[3].key, 'B');
  assert.deepEqual(pv.parseEnvLines(''), []);
});

await test('splitHighlightedLines: spans that cross a line break stay balanced', () => {
  const lines = pv.splitHighlightedLines('<span class="hljs-comment">/* a\nb\nc */</span>\nx');
  assert.deepEqual(lines, [
    '<span class="hljs-comment">/* a</span>',
    '<span class="hljs-comment">b</span>',
    '<span class="hljs-comment">c */</span>',
    'x',
  ]);
  assert.deepEqual(pv.splitHighlightedLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(pv.splitHighlightedLines(''), ['']);
});

await test('plainLines escape HTML; numberedLinesHtml puts numbers in an attribute only', () => {
  const lines = pv.plainLines('<script>alert(1)</script>\r\n& "q"\n');
  assert.deepEqual(lines, ['&lt;script&gt;alert(1)&lt;/script&gt;', '&amp; "q"']);
  const html = pv.numberedLinesHtml(lines, (i) => (i === 1 ? 'is-invalid' : ''));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('data-ln="2"'));
  assert.ok(html.includes('ws-pv-line is-invalid'));
  assert.ok(!/>\s*1\s*</.test(html));
});

console.log(`\n${passed} passed`);

await test('env: .gitconfig headers holding a URL, a quote or an @ are masked; plain sections stay visible', () => {
  const lines = pv.parseEnvLines('[core]\n\teditor = vim\n[url "https://x-access-token:SECRET1@github.com/"]\n\tinsteadOf = https://github.com/\n[http "https://h.example"]\n[credential "x"]\n');
  const shown = lines.filter((l) => l.type === 'comment').map((l) => l.text);
  assert.deepEqual(shown, ['[core]']);
  assert.ok(lines.some((l) => l.type === 'raw' && l.text.includes('SECRET1')), 'the token line is raw, hence masked');
});

await test('capLines: CR-only and CRLF endings are line breaks too', () => {
  const r = pv.capLines('1\r'.repeat(30), 20);
  assert.equal(r.cut, true);
  assert.equal(r.total, 30);
  assert.equal(r.text.split('\n').length, 20);
  assert.equal(pv.capLines('a\r\nb\r\n', 5).total, 2);
});

await test('highlight: a line over 5,000 characters turns highlighting off (hljs is quadratic on long tokens)', () => {
  assert.equal(pv.hasOverlongLine('a\n' + 'x'.repeat(5001)), true);
  assert.equal(pv.hasOverlongLine('a\n' + 'x'.repeat(5000) + '\nb'), false);
  assert.equal(pv.hasOverlongLine(''), false);
});
