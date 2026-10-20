/**
 * Safe Markdown to HTML for the Workspace preview.
 *
 * Two layers, so one mistake in either is not enough to run script:
 *  1. `marked` (GFM) with three renderer hooks that never emit raw HTML: `html` returns the source
 *     text escaped, `image` returns the alt text escaped (no <img> for now), `checkbox` returns a ballot-box character.
 *  2. A strict allow-list pass over marked's output, written without a DOM (it runs in node tests
 *     and in the browser the same way): every tag outside the list is dropped, every attribute is
 *     dropped except `href` on `a` (http, https, mailto or `#`) and `class="language-x"` on `code`;
 *     a `<` that does not start a well-formed tag is escaped.
 */
import { Marked } from 'marked';

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'del', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br',
]);
const VOID_TAGS = new Set(['hr', 'br']);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    image({ text }) { return escapeHtml(text); },
    checkbox({ checked }) { return checked ? '\u2611 ' : '\u2610 '; },
  },
});

// A well-formed tag: name, then attributes whose quoted values may hold `>`.
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Decodes numeric entities and the few named ones that matter; an unknown entity stays as typed. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_m, n: string) => (
      { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>
    )[n.toLowerCase()]);
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

// Control, whitespace, zero-width and line-separator characters a browser ignores inside a URL scheme.
const STRIP_RE = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

/** Returns a clean href, or null when the link must be dropped. Allow-list: http, https, mailto, `#`. */
function safeHref(raw: string): string | null {
  const value = decodeEntities(raw).replace(STRIP_RE, '');
  if (!value) return null;
  if (value.startsWith('#')) return value;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!scheme) return null;
  const s = scheme[1].toLowerCase();
  return s === 'http' || s === 'https' || s === 'mailto' ? value : null;
}

/** The allow-list pass alone, exported so tests can feed it hostile HTML directly. */
export function sanitizeHtml(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i).replace(/>/g, '&gt;'); break; }
    out += html.slice(i, lt).replace(/>/g, '&gt;');
    const m = TAG_RE.exec(html.slice(lt));
    if (!m) { out += '&lt;'; i = lt + 1; continue; }
    i = lt + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) { if (!VOID_TAGS.has(name)) out += `</${name}>`; continue; }
    if (VOID_TAGS.has(name)) { out += `<${name}>`; continue; }
    let attrs = '';
    if (name === 'a') {
      ATTR_RE.lastIndex = 0;
      let href: string | null = null;
      for (let a = ATTR_RE.exec(m[3]); a; a = ATTR_RE.exec(m[3])) {
        if (a[1].toLowerCase() === 'href') href = safeHref(a[2] ?? a[3] ?? a[4] ?? '');
      }
      // An in-page anchor stays in the page; every other link opens in a new tab, without an opener.
      if (href) attrs = href.startsWith("#") ? ` href="${escapeHtml(href)}"` : ` href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank"`;
    } else if (name === 'code') {
      ATTR_RE.lastIndex = 0;
      for (let a = ATTR_RE.exec(m[3]); a; a = ATTR_RE.exec(m[3])) {
        const cls = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
        if (a[1].toLowerCase() === 'class' && /^language-[\w-]+$/.test(cls)) attrs = ` class="${cls}"`;
      }
    } else if (name === 'th' || name === 'td') {
      // Column alignment from a GFM table (`:--:`): only these three values are kept.
      ATTR_RE.lastIndex = 0;
      for (let a = ATTR_RE.exec(m[3]); a; a = ATTR_RE.exec(m[3])) {
        const v = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '').toLowerCase();
        if (a[1].toLowerCase() === 'align' && (v === 'left' || v === 'center' || v === 'right')) attrs = ` align="${v}"`;
      }
    }
    out += `<${name}${attrs}>`;
  }
  return out;
}

/** Renders Markdown to HTML that is safe to inject: no script, no event handler, no unsafe URL. */
export function renderMarkdownSafe(text: string): string {
  const html = marked.parse(text ?? '', { async: false });
  return sanitizeHtml(typeof html === 'string' ? html : '');
}
