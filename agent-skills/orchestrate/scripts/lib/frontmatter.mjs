// The subset of YAML that Backlog.md writes in a task's front matter: scalars (plain, 'single', "double"),
// folded and literal blocks (>-, |), inline lists [a, b] and block lists ("- item"). Nested maps are skipped. Reading only: edits to the file
// are done line by line by the tracker adapter, so the rest of the file stays byte for byte.

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function frontMatterRange(text) {
  const m = text.match(FM);
  return m ? { start: 0, end: m[0].length, inner: m[1], innerStart: m[0].indexOf(m[1]) } : null;
}

function scalar(v) {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

function inlineList(v) {
  const body = v.trim().slice(1, -1);
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === q && body[i + 1] === q && q === "'") { cur += body[++i]; } else if (c === q) q = null; }
    else if (c === "'" || c === '"') { q = c; cur += c; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(scalar).filter(x => x !== '');
}

function value(v) {
  const s = v.trim();
  if (s.startsWith('[') && s.endsWith(']')) return inlineList(s);
  return scalar(s);
}

export function parseFrontMatter(text) {
  const r = frontMatterRange(text);
  if (!r) return { data: {}, body: text };
  const data = {}; let key = null; let nested = false; let block = null; // block: { style, lines }
  const endBlock = () => {
    if (!block) return;
    const lines = block.lines.map(l => l.replace(/^\s+/, ''));
    let text = block.style.startsWith('|') ? lines.join('\n') : lines.join(' ').replace(/\s+/g, ' ');
    if (block.style.endsWith('-')) text = text.replace(/\s+$/, '');
    data[key] = text.trim(); block = null;
  };
  for (const line of r.inner.split(/\r?\n/)) {
    if (block) {
      if (!line.trim() || /^\s/.test(line)) { block.lines.push(line); continue; }
      endBlock();
    }
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/) || line.match(/^\s*-$/);
    if (item && key && !nested) {
      if (!Array.isArray(data[key])) data[key] = [];
      if (item[1] !== undefined) data[key].push(scalar(item[1]));
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (top) {
      key = top[1]; nested = false;
      if (top[2] && /^[>|][+-]?$/.test(top[2].trim())) { block = { style: top[2].trim(), lines: [] }; continue; }
      data[key] = top[2] === undefined || top[2].trim() === '' ? null : value(top[2]);
      continue;
    }
    if (/^\s+[A-Za-z0-9_-]+:/.test(line)) { nested = true; continue; } // nested map: not used by the skill
  }
  endBlock();
  return { data, body: text.slice(r.end) };
}

export const asList = v => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

// Quote a scalar unless YAML would read it back as the same string: plain only when it starts with a letter or "_"
// (never "-", a digit or "." — a list item, a number, 0x1F, 1e3) and is not a YAML boolean or null.
export function yamlScalar(s) {
  const v = String(s);
  return /^[A-Za-z_][A-Za-z0-9 _./-]*$/.test(v) && v.trim() === v && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(v)
    ? v : `'${v.replace(/'/g, "''")}'`;
}
