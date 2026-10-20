#!/usr/bin/env node
/**
 * Tests for lib/markdown-safe.ts (the Workspace Markdown preview): no script, no event handler,
 * no unsafe URL, and the Markdown that used to render wrong now renders right.
 *
 *   node scripts/test-workspace-markdown.mjs
 */
import assert from 'node:assert/strict';

const { renderMarkdownSafe, sanitizeHtml } = await import('../lib/markdown-safe.ts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

/**
 * What must hold for every hostile input. Text that merely QUOTES an attack (an escaped "onmouseover=")
 * is inert, so the checks look at the markup: every tag the output contains, and every attribute in it.
 */
function assertInert(html, label) {
  const tags = html.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) {
    assert.match(tag, /^<\/?(p|h[1-6]|ul|ol|li|blockquote|pre|code|em|strong|del|a|table|thead|tbody|tr|th|td|hr|br)(\s|>)/, `${label}: tag outside the list: ${tag} in ${html}`);
    assert.doesNotMatch(tag, /\bon\w+\s*=/i, `${label}: event handler in ${tag}`);
    assert.doesNotMatch(tag, /(javascript|vbscript|data):/i, `${label}: unsafe URL in ${tag}`);
    assert.doesNotMatch(tag, /\b(style|src|srcdoc|formaction|xlink:href)\s*=/i, `${label}: unsafe attribute in ${tag}`);
  }
  // Only these attributes may appear at all.
  for (const m of html.matchAll(/<(a|code)\b([^>]*)>/g)) {
    const names = [...m[2].matchAll(/\s([a-z-]+)=/g)].map((x) => x[1]).sort().join(',');
    assert.ok(m[1] === 'a' ? ['', 'href,rel,target'].includes(names) : ['', 'class'].includes(names), `${label}: attributes [${names}] on <${m[1]}>`);
  }
  assert.doesNotMatch(html, /<script/i, `${label}: <script in ${html}`);
}

test('analysis payload 1: attribute injection through a quote in the link target', () => {
  const html = renderMarkdownSafe('[hover](x" onmouseover="document.title=\'XSS-FIRED\'")');
  assertInert(html, 'payload 1');
  assert.doesNotMatch(html, /<a\b/);
});

test('analysis payload 2: javascript: link', () => {
  const html = renderMarkdownSafe('[x](javascript:alert(document.domain))');
  assertInert(html, 'payload 2');
  assert.doesNotMatch(html, /href=/);
});

test('raw <img onerror> is shown as text, not rendered', () => {
  const html = renderMarkdownSafe('hello <img src=x onerror=alert(1)> world');
  assertInert(html, 'img');
  assert.match(html, /&lt;img/);
});

test('markdown image syntax produces no <img>', () => {
  const html = renderMarkdownSafe('![alt text](http://x/a.png "t")');
  assertInert(html, 'md image');
  assert.match(html, /alt text/);
});

test('raw <script> block and inline are escaped', () => {
  assertInert(renderMarkdownSafe('<script>alert(1)</script>'), 'block');
  assertInert(renderMarkdownSafe('text <script>alert(1)</script> text'), 'inline');
  assert.match(renderMarkdownSafe('<script>alert(1)</script>'), /&lt;script&gt;/);
});

test('raw <a onmouseover> is escaped, not a link', () => {
  const html = renderMarkdownSafe('<a href="http://e.x" onmouseover="alert(1)">x</a>');
  assertInert(html, 'raw anchor');
  assert.doesNotMatch(html, /<a\b/);
});

test('unsafe schemes are dropped in any case, with entities and whitespace', () => {
  const links = [
    '[a](JaVaScRiPt:alert(1))',
    '[a](javascript&colon;alert(1))',
    '[a](&#106;avascript:alert(1))',
    '[a](&#x6A;avascript:alert(1))',
    '[a](java&#9;script:alert(1))',
    '[a](java&Tab;script:alert(1))',
    '[a](<java\tscript:alert(1)>)',
    '[a](<  javascript:alert(1)>)',
    '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[a](DATA:text/html,<script>alert(1)</script>)',
    '[a](vbscript:msgbox(1))',
    '[a](VBScript:msgbox(1))',
    '[a](file:///etc/passwd)',
    '[a](//evil.example/x)',
    '[a]( javascript:alert(1))',
  ];
  for (const md of links) {
    const html = renderMarkdownSafe(md);
    assertInert(html, md);
    assert.doesNotMatch(html, /href=/, `${md} kept an href: ${html}`);
  }
});

test('a reference-style link with a bad scheme is dropped', () => {
  const html = renderMarkdownSafe('[a][1]\n\n[1]: javascript:alert(1)');
  assertInert(html, 'reference link');
});

test('an autolink and a bare URL with a bad scheme are dropped', () => {
  assertInert(renderMarkdownSafe('<javascript:alert(1)>'), 'autolink');
  assertInert(renderMarkdownSafe('javascript:alert(1)'), 'bare');
});

test('a quote in the link title cannot add an attribute', () => {
  const html = renderMarkdownSafe('[a](http://e.x "t\\" onmouseover=\\"alert(1)")');
  assertInert(html, 'title');
  assert.doesNotMatch(html, /title=/);
});

test('safe links keep href, rel and target; mailto and # work', () => {
  const html = renderMarkdownSafe('[w](https://example.com/a?b=1&c=2) [m](mailto:a@b.co) [h](#top) [p](http://e.x)');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">w<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.co" rel="noopener noreferrer" target="_blank">m<\/a>/);
  assert.match(html, /<a href="#top">h<\/a>/, "an in-page anchor stays in the page");
  assert.match(html, /<a href="http:\/\/e\.x" rel="noopener noreferrer" target="_blank">p<\/a>/);
});

test('GFM table renders as a table', () => {
  const html = renderMarkdownSafe('| a | b |\n|---|:-:|\n| 1 | 2 |\n');
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<th align="center">b<\/th>/, "column alignment is kept (left|center|right only)");
  assert.doesNotMatch(html, /\|/);
});

test('a fenced code block keeps * and < literal and keeps the language class', () => {
  const html = renderMarkdownSafe('```ts\nconst a = 1 * 2 * 3; // <b>x</b>\n```\n');
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /1 \* 2 \* 3;/);
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('inline code with * is not emphasis', () => {
  const html = renderMarkdownSafe('use `a*b*c` here');
  assert.match(html, /<code>a\*b\*c<\/code>/);
  assert.doesNotMatch(html, /<em>/);
});

test('a code class outside language-* is dropped, injected handlers too', () => {
  // The sanitizer is the second layer: feed it what a broken first layer could emit.
  const html = renderMarkdownSafe('```x" onclick="alert(1)\ncode\n```');
  assertInert(html, 'fence info');
  assert.doesNotMatch(html, /onclick/);
  assert.doesNotMatch(html, /class="x/);
});

test('lists, headings, emphasis, blockquote and hr render', () => {
  const html = renderMarkdownSafe('# T\n\n- a\n- b\n\n1. x\n2. y\n\n**b** *i* ~~d~~\n\n> q\n\n---\n');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
  assert.match(html, /<del>d<\/del>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
});

test('task list items show as text, with no <input>', () => {
  const html = renderMarkdownSafe('- [x] done\n- [ ] todo\n');
  assertInert(html, 'task list');
  assert.match(html, /\u2611 done/);
  assert.match(html, /\u2610 todo/);
});

test('raw HTML such as <iframe>, <style>, <svg onload> and entities in text stay inert', () => {
  for (const md of [
    '<iframe src="http://e.x"></iframe>',
    '<style>body{display:none}</style>',
    '<svg onload=alert(1)>',
    '<details open ontoggle=alert(1)>x</details>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '<<script>script>alert(1)<</script>/script>',
  ]) assertInert(renderMarkdownSafe(md), md);
});

test('the allow-list pass alone cleans hostile HTML (second layer)', () => {
  assert.equal(sanitizeHtml('<code class="language-ts">x</code>'), '<code class="language-ts">x</code>');
  assert.equal(sanitizeHtml('<code class="x" onclick="alert(1)">x</code>'), '<code>x</code>');
  assert.equal(sanitizeHtml('<code class="language-ts" onclick="alert(1)">x</code>'), '<code class="language-ts">x</code>');
  assert.equal(sanitizeHtml('<code class="language-a b">x</code>'), '<code>x</code>');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)" onmouseover="x">y</a>'), '<a>y</a>');
  assert.equal(sanitizeHtml('<a href='+"'"+' JAVA&#x09;script:1'+"'"+'>y</a>'), '<a>y</a>');
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>t'), 't');
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), 'alert(1)');
  assert.equal(sanitizeHtml('a < b <b'), 'a &lt; b &lt;b');
  assert.equal(sanitizeHtml('<p onclick=x>t</p>'), '<p>t</p>');
  assertInert(sanitizeHtml('<a href="https://e.x" title="a>b" onfocus="x">z</a>'), 'quoted >');
});

test('empty and non-string input do not throw', () => {
  assert.equal(renderMarkdownSafe(''), '');
  assert.equal(typeof renderMarkdownSafe(undefined), 'string');
});

console.log(`\n${passed} passed`);

test('GFM task lists and column alignment survive, nothing else on th/td', () => {
  const html = renderMarkdownSafe('- [x] done\n- [ ] todo\n\n| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n');
  assert.match(html, /\u2611 done/);
  assert.match(html, /\u2610 todo/);
  assert.match(html, /<th align="center">C<\/th>/);
  assert.match(html, /<td align="right">c<\/td>/);
  assert.doesNotMatch(html, /<input/);
  const evil = renderMarkdownSafe('<table><tr><td align="center" onclick="x()" style="color:red">z</td><td align="javascript:x">y</td></tr></table>');
  assertInert(evil, "raw table HTML");
  assert.doesNotMatch(evil, /<td[^>]*(onclick|style|javascript)/);
});
