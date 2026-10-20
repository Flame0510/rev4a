/**
 * Pure helpers for the Workspace file previews: which preview a file name gets, which
 * highlight.js language it uses, JSON error positions, .env masking and line splitting of
 * highlighted HTML. No imports, so scripts/test-workspace-preview.mjs can load it directly.
 */

export type PreviewKind = 'code' | 'json' | 'yaml' | 'csv' | 'tsv' | 'env';

/** Highlight.js languages the preview registers (the module name under highlight.js/lib/languages). */
export const PREVIEW_LANGS = [
  'typescript', 'javascript', 'python', 'bash', 'css', 'scss', 'xml', 'json', 'yaml', 'ini', 'sql',
  'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'c', 'cpp', 'csharp', 'swift', 'dockerfile',
  'makefile', 'diff',
] as const;
export type PreviewLang = (typeof PREVIEW_LANGS)[number];

/** Extension (lower case, no dot) to language. */
const EXT_LANG: Record<string, PreviewLang> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'scss',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', jsonl: 'json', ndjson: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
  diff: 'diff', patch: 'diff',
};

/** Well-known file names without a useful extension (lower case). */
const NAME_LANG: Record<string, PreviewLang> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash', '.zprofile': 'bash', '.profile': 'bash',
  '.bash_aliases': 'bash', '.zshenv': 'bash',
  '.gitignore': 'bash', '.dockerignore': 'bash', '.npmignore': 'bash',
  '.gitattributes': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini',
};

/** Fence names used in Markdown to language. */
const FENCE_ALIAS: Record<string, PreviewLang> = {
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  js: 'javascript', jsx: 'javascript', javascript: 'javascript', node: 'javascript',
  py: 'python', python: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  css: 'css', scss: 'scss',
  html: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', conf: 'ini',
  sql: 'sql', go: 'go', golang: 'go', rust: 'rust', rs: 'rust', java: 'java', kotlin: 'kotlin', kt: 'kotlin',
  ruby: 'ruby', rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', hpp: 'cpp',
  cs: 'csharp', csharp: 'csharp', swift: 'swift', dockerfile: 'dockerfile', docker: 'dockerfile',
  makefile: 'makefile', make: 'makefile', diff: 'diff', patch: 'diff',
};

/** Own-property lookup: file names like `constructor` or `__proto__` must not reach Object.prototype. */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return (slash >= 0 ? name.slice(slash + 1) : name).toLowerCase();
}

function extOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

/** Credential files that are previewed like .env: values hidden until revealed. */
const SECRET_FILES = new Set(['.npmrc', '.netrc', '.pgpass', '.git-credentials', '.gitconfig']);

function isEnvName(base: string): boolean {
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env') || SECRET_FILES.has(base);
}

/**
 * Which read-only preview a file name gets, or null when the page should keep its textarea.
 * Markdown is not here: the page has its own preview for it.
 */
export function previewKindOf(name: string): PreviewKind | null {
  const base = baseName(name);
  if (!base) return null;
  if (isEnvName(base)) return 'env';
  const ext = extOf(base);
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv') return 'tsv';
  if (own(NAME_LANG, base) || base.startsWith('dockerfile.')) return 'code';
  if (ext && own(EXT_LANG, ext)) return 'code';
  return null;
}

/** highlight.js language for a file name, or null (plain text). */
export function languageOf(name: string): PreviewLang | null {
  const base = baseName(name);
  const named = own(NAME_LANG, base);
  if (named) return named;
  if (base.startsWith('dockerfile.')) return 'dockerfile';
  const ext = extOf(base);
  return (ext && own(EXT_LANG, ext)) || null;
}

/** highlight.js language for a Markdown fence name (`js`, `sh`, `c++`...), or null. */
export function fenceLanguage(fence: string): PreviewLang | null {
  return own(FENCE_ALIAS, fence.trim().toLowerCase()) ?? null;
}

/** True for JSON Lines files (one JSON value per line). */
export function isJsonLines(name: string): boolean {
  const ext = extOf(baseName(name));
  return ext === 'jsonl' || ext === 'ndjson';
}

// ---------------------------------------------------------------------------------------------
// JSON

export interface JsonErrorInfo {
  line: number;
  column: number;
  message: string;
}

/** 1-based line and column of a character offset in `text`. */
export function lineColumnAt(text: string, position: number): { line: number; column: number } {
  const end = Math.max(0, Math.min(position, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, column: end - lineStart + 1 };
}

/**
 * Locate the first syntax error of a JSON text with a small recursive-descent scan. Engines word
 * JSON.parse errors differently (and recent ones often omit the position), so the position comes
 * from here. Returns null when the text is valid.
 */
export function findJsonError(text: string): { position: number; message: string } | null {
  const n = text.length;
  let i = 0;
  const fail = (position: number, message: string) => { throw { position, message }; };
  const tokenAt = (p: number) => (p >= n ? 'Unexpected end of JSON input' : `Unexpected token ${JSON.stringify(text[p])}`);
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const str = () => {
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i, 'Bad Unicode escape');
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(i + 1, e === undefined ? 'Unterminated string' : 'Bad escaped character');
      } else if (c < ' ') fail(i, 'Bad control character in string literal');
      else i++;
    }
    fail(n, 'Unterminated string');
  };
  const value = (depth: number) => {
    if (depth > 512) fail(i, 'Nesting is too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(i, i >= n ? tokenAt(i) : `Expected a property name, found ${JSON.stringify(text[i])}`);
        str(); ws();
        if (text[i] !== ':') fail(i, i >= n ? tokenAt(i) : "Expected ':' after the property name");
        i++;
        value(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail(i, i >= n ? tokenAt(i) : "Expected ',' or '}' after the property value");
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail(i, i >= n ? tokenAt(i) : "Expected ',' or ']' after the array element");
      }
    } else if (c === '"') str();
    else if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m) fail(c === '-' ? i + 1 : i, tokenAt(c === '-' ? i + 1 : i));
      else i += m[0].length;
    } else {
      for (const lit of ['true', 'false', 'null']) {
        if (text.startsWith(lit, i)) { i += lit.length; return; }
      }
      fail(i, tokenAt(i));
    }
  };
  try {
    value(0); ws();
    if (i < n) fail(i, `Unexpected token ${JSON.stringify(text[i])} after the JSON value`);
    return null;
  } catch (e) {
    if (e && typeof e === 'object' && 'position' in e) return e as { position: number; message: string };
    throw e;
  }
}

/**
 * Turn a JSON.parse failure into a line, a column and a short message. The position comes from
 * findJsonError; when that scan finds nothing (it disagrees with the engine) the engine message
 * is used: "... at position N" or "line X column Y" when present, line 1 column 1 otherwise.
 */
export function jsonErrorInfo(text: string, error: unknown): JsonErrorInfo {
  const found = findJsonError(text);
  if (found) {
    const { line, column } = lineColumnAt(text, found.position);
    return { line, column, message: found.message };
  }
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw.replace(/\s*\(line \d+ column \d+\)\s*$/, '').trim();
  const pos = /position (\d+)/.exec(raw);
  if (pos) {
    const { line, column } = lineColumnAt(text, Number(pos[1]));
    return { line, column, message };
  }
  const lc = /line (\d+) column (\d+)/.exec(raw);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]), message };
  if (!message) message = 'Invalid JSON';
  return { line: 1, column: 1, message };
}

/** Deepest nesting of [ and { outside strings. Cheap and linear; used before pretty-printing. */
export function jsonMaxDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

/** Longest nesting the pretty printer is asked to format (2-space indent grows quadratically). */
export const JSON_MAX_DEPTH = 200;
/** Pretty JSON longer than this is not shown; the raw text is. */
export const JSON_MAX_PRETTY_CHARS = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Line cap

/** Most lines any preview renders. */
export const MAX_RENDER_LINES = 20000;
/** Most CSV columns the table renders. */
export const CSV_MAX_COLS = 200;

/** The first `max` lines of `text`, how many lines it has in all, and whether it was cut. */
export function capLines(text: string, max: number = MAX_RENDER_LINES): { text: string; total: number; cut: boolean } {
  // CR-only and CRLF endings count as line breaks too (a CR-only file would otherwise be one
  // "line" and get past the cap while rendering as many rows).
  text = text.replace(/\r\n?/g, '\n');
  let count = 0;
  let cutAt = -1;
  let idx = -1;
  while ((idx = text.indexOf('\n', idx + 1)) !== -1) {
    count++;
    if (count === max) cutAt = idx;
  }
  const total = count + (text.length > 0 && !text.endsWith('\n') ? 1 : 0);
  if (total <= max || cutAt < 0) return { text, total, cut: false };
  return { text: text.slice(0, cutAt), total, cut: true };
}

// ---------------------------------------------------------------------------------------------
// .env

export const ENV_MASK = '••••••';

export type EnvLine =
  | { type: 'blank' }
  | { type: 'comment'; text: string }
  | { type: 'pair'; prefix: string; key: string; value: string }
  /** Anything else (a continuation of a multi-line value, say). Treated as a secret. */
  | { type: 'raw'; text: string };

const ENV_PAIR = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.\-]*)\s*=(.*)$/;
const ENV_SECTION = /^\s*\[[^\]\n]*\]\s*$/;

/** True when `rest` (text after an opening quote) contains the matching closing quote. */
function closesQuote(rest: string, quote: string): boolean {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\' && quote !== "'") { i++; continue; }
    if (rest[i] === quote) return true;
  }
  return false;
}

/**
 * Classify the lines of a .env-like file. A quoted value that does not close on its line runs
 * over the following lines (a PEM key, say): every line up to the closing quote is `raw`, even
 * one that starts with # or looks like KEY=. A value ending in a backslash continues too. When in
 * doubt a line is `raw`, and raw lines are masked.
 */
export function parseEnvLines(text: string): EnvLine[] {
  const norm = text.replace(/\r\n?/g, '\n');
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  if (body === '') return norm === '' ? [] : [{ type: 'blank' }];
  let openQuote: string | null = null;
  let continued = false;
  return body.split('\n').map((line): EnvLine => {
    if (openQuote) {
      if (closesQuote(line, openQuote)) openQuote = null;
      return { type: 'raw', text: line };
    }
    if (continued) {
      continued = line.trimEnd().endsWith('\\');
      return { type: 'raw', text: line };
    }
    if (line.trim() === '') return { type: 'blank' };
    // A plain [section] header is shown; one with a quoted subsection, a URL or an @ (.gitconfig's
    // [url "https://x-access-token:TOKEN@github.com/"], [http "…"], [credential "…"]) can hold a
    // secret, so it is masked like a value.
    if (ENV_SECTION.test(line)) return /["'@]|:\/\//.test(line) ? { type: 'raw', text: line } : { type: 'comment', text: line };
    if (line.trimStart().startsWith('#')) return { type: 'comment', text: line };
    const m = ENV_PAIR.exec(line);
    if (m) {
      const value = m[3].trim();
      const q = value[0];
      if ((q === '"' || q === "'" || q === '`') && !closesQuote(value.slice(1), q)) openQuote = q;
      else if (value.endsWith('\\')) continued = true;
      return { type: 'pair', prefix: m[1], key: m[2], value: m[3] };
    }
    return { type: 'raw', text: line };
  });
}

/** The text of a .env file with every value replaced by the mask. Contains no value. */
export function maskEnvText(text: string): string {
  return parseEnvLines(text)
    .map((l) => {
      if (l.type === 'blank') return '';
      if (l.type === 'comment') return l.text;
      if (l.type === 'pair') return `${l.prefix}${l.key}=${l.value.trim() === '' ? '' : ENV_MASK}`;
      return ENV_MASK;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Numbered lines

export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Split highlight.js HTML (spans only) into one HTML string per line, closing the spans that
 * are open at a line break and reopening them on the next line, so every line is balanced.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = []; // opening tags currently open
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end < 0) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) open.pop();
      else open.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === '\n') {
      cur += '</span>'.repeat(open.length);
      lines.push(cur);
      cur = open.join('');
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  lines.push(cur);
  // A final newline in the source is not an extra empty line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Plain text split into lines of escaped HTML. */
export function plainLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(escapeHtmlText);
}

/** Wrap per-line HTML into numbered rows. The number is drawn by CSS, so it is not selectable or copied. */
export function numberedLinesHtml(lines: string[], rowClass?: (index: number) => string): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const extra = rowClass ? rowClass(i) : '';
    out += `<div class="ws-pv-line${extra ? ` ${extra}` : ''}" data-ln="${i + 1}"><span class="ws-pv-lc">${lines[i]}</span></div>`;
  }
  return out;
}

/**
 * highlight.js takes quadratic time on a long unbroken token (a 64 KB run of one character took 26 s
 * in TypeScript): text with any line longer than this is left plain.
 */
export const HIGHLIGHT_MAX_LINE_CHARS = 5000;

/** True when some line of `text` is longer than HIGHLIGHT_MAX_LINE_CHARS. */
export function hasOverlongLine(text: string): boolean {
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    if (end - start > HIGHLIGHT_MAX_LINE_CHARS) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}
