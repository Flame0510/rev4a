// Owned-file globs, as written in a task's modified_files.
//   **  any number of path segments (also none)
//   *   any characters inside one segment
//   ?   one character inside one segment
// Brackets are literal (Next.js routes such as app/table/[token]/page.tsx).
// A pattern without wildcards names a file or a whole directory; a trailing / means the directory.

const norm = p => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, m => (m ? '/' : ''));
const hasWild = s => /[*?]/.test(s);
const escape = s => s.replace(/[.+^${}()|[\]\\]/g, c => `\\${c}`);

function segmentRegex(seg) {
  return new RegExp(`^${seg.split('').map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escape(c))).join('')}$`);
}

function segments(pattern) {
  let p = norm(pattern);
  if (p.endsWith('/')) p += '**';
  const segs = p.split('/').filter(Boolean);
  // A literal path also covers what is inside it, if it is a directory.
  return hasWild(p) ? segs : [...segs, '**'];
}

function matchSegs(pat, parts) {
  if (!pat.length) return !parts.length;
  if (pat[0] === '**') {
    for (let i = 0; i <= parts.length; i++) if (matchSegs(pat.slice(1), parts.slice(i))) return true;
    return false;
  }
  if (!parts.length) return false;
  const ok = hasWild(pat[0]) ? segmentRegex(pat[0]).test(parts[0]) : pat[0] === parts[0];
  return ok && matchSegs(pat.slice(1), parts.slice(1));
}

export function matches(pattern, file) {
  const p = norm(pattern);
  if (!p) return false;
  return matchSegs(segments(p), norm(file).split('/').filter(Boolean));
}

export const matchesAny = (patterns, file) => patterns.some(p => matches(p, file));

// Could some path match both patterns? Conservative: when unsure, yes.
function overlapSegs(a, b) {
  if (!a.length && !b.length) return true;
  if (a[0] === '**' || b[0] === '**') return true;
  if (!a.length || !b.length) return false;
  const [x, y] = [a[0], b[0]];
  const ok = !hasWild(x) && !hasWild(y) ? x === y
    : hasWild(x) && hasWild(y) ? true
      : hasWild(x) ? segmentRegex(x).test(y) : segmentRegex(y).test(x);
  return ok && overlapSegs(a.slice(1), b.slice(1));
}

export function patternsOverlap(a, b) {
  if (!norm(a) || !norm(b)) return false;
  return overlapSegs(segments(a), segments(b));
}

// The first pair of patterns from two lists that may overlap, or null.
export function firstOverlap(listA, listB) {
  for (const a of listA) for (const b of listB) if (patternsOverlap(a, b)) return [a, b];
  return null;
}
