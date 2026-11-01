// Tracker adapter for Backlog.md (https://github.com/MrLesk/Backlog.md): one Markdown file per task in
// <dir>/tasks/, YAML front matter, sections between <!-- SECTION:…:BEGIN/END --> markers.
// Every adapter exposes the same calls: list, get, setStatus, comment, and create/update for `orch card` (cards in the
// skill's format, lib/card.mjs). The rest of the skill only uses those.
//
// Front matter fields read: id, title, status, dependencies, priority, ordinal, modified_files (the owned-file
// globs), and three optional ones for the gate: checks (extra commands), harnesses (names to run even when no
// covered path changes) and no_tests (why this task needs no test; set by the owner); for orch card also kind,
// external_flows and labels. Status and comment edits touch only the status and updated_date lines and the
// Implementation Notes section; update rewrites only the card's own fields and the Description and Acceptance Criteria
// sections. Every write is atomic.
import fs from 'node:fs';
import path from 'node:path';
import { asList, frontMatterRange, parseFrontMatter, yamlScalar } from '../lib/frontmatter.mjs';
import { now, OrchError, writeAtomic } from '../lib/util.mjs';

const SECTIONS = { description: 'DESCRIPTION', plan: 'PLAN', notes: 'NOTES', summary: 'FINAL_SUMMARY' };
const HEADINGS = { description: 'Description', plan: 'Implementation Plan', notes: 'Implementation Notes', summary: 'Final Summary', acceptance: 'Acceptance Criteria' };

function between(text, begin, end) {
  const i = text.indexOf(begin); if (i < 0) return null;
  const j = text.indexOf(end, i + begin.length); if (j < 0) return null;
  return text.slice(i + begin.length, j).trim();
}

function byHeading(text, heading) {
  const m = text.match(new RegExp(`^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : null;
}

function section(body, key) {
  if (key === 'acceptance') return between(body, '<!-- AC:BEGIN -->', '<!-- AC:END -->') ?? byHeading(body, HEADINGS.acceptance) ?? '';
  const m = SECTIONS[key];
  return between(body, `<!-- SECTION:${m}:BEGIN -->`, `<!-- SECTION:${m}:END -->`) ?? byHeading(body, HEADINGS[key]) ?? '';
}

// The project's own statuses from backlog/config.yml (`statuses: [...]`), if it lists them.
function configuredStatuses(dir) {
  const file = path.join(dir, 'config.yml');
  if (!fs.existsSync(file)) return null;
  const { data } = parseFrontMatter(`---\n${fs.readFileSync(file, 'utf8')}\n---\n`);
  return Array.isArray(data.statuses) && data.statuses.length ? data.statuses.map(String) : null;
}

export function detect(root) {
  const dir = path.join(root, 'backlog');
  if (!fs.existsSync(path.join(dir, 'tasks'))) return null;
  return { kind: 'backlog-md', dir: 'backlog', statuses: configuredStatuses(dir) };
}

// The card's own front matter keys, in the order Backlog.md writes them, and the card field each one holds.
const CARD_KEYS = [
  ['title', c => c.title], ['labels', c => c.labels], ['dependencies', c => c.dependencies],
  ['modified_files', c => c.owned], ['parent_task_id', c => c.parent], ['priority', c => c.priority], ['kind', c => c.kind],
  ['external_flows', c => c.external], ['checks', c => c.checks], ['no_tests', c => c.noTests],
];
const ALWAYS = new Set(['title', 'labels', 'dependencies']); // written even when empty, as Backlog.md does

function renderKey(key, v) {
  if (Array.isArray(v)) return v.length ? [`${key}:`, ...v.map(x => `  - ${yamlScalar(x)}`)] : [`${key}: []`];
  return [`${key}: ${yamlScalar(v)}`];
}

const isEmpty = v => (Array.isArray(v) ? v.length === 0 : !v);

// Front matter split into top-level key blocks (the key line plus its list or indented lines), so one key can be
// replaced without touching the others.
function keyBlocks(inner) {
  const blocks = [];
  for (const line of inner.split(/\r?\n/)) {
    const k = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (k || !blocks.length) blocks.push({ key: k ?? null, lines: [line] });
    else blocks.at(-1).lines.push(line);
  }
  return blocks;
}

const slug = t => t.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'task';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, c => `\\${c}`);
const norm = s => s.replace(/\s+/g, ' ').trim();

// Acceptance criteria as Backlog.md writes them. A criterion already ticked in the file stays ticked.
function acLines(card, ticked = new Set()) {
  return card.acceptance.map((a, i) => `- [${ticked.has(norm(a)) ? 'x' : ' '}] #${i + 1} ${a}`).join('\n');
}

// Where a "## Heading" section ends: the next "## " heading or the end of the text.
// Headings inside a fenced code block are text, not sections.
function headingRange(text, heading) {
  const lines = text.split('\n');
  let pos = 0; let fence = false; let start = -1;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^## /.test(line)) {
      if (start >= 0) return { start, end: pos };
      if (line.replace(/[ \t]+$/, '') === `## ${heading}`) start = pos;
    }
    pos += line.length + 1;
  }
  return start >= 0 ? { start, end: text.length } : null;
}

// Sets a section's content. Between its markers when they exist; a section with the heading but no markers (written
// by hand) is replaced; a missing one is added after `afterHeading`'s section, or after the front matter.
function setSection(text, { begin, end, heading, afterHeading, afterMarker, gap }, content) {
  const i = text.indexOf(begin); const j = i >= 0 ? text.indexOf(end, i) : -1;
  if (i >= 0 && j >= 0) return `${text.slice(0, i + begin.length)}\n${content}\n${text.slice(j)}`;
  const block = `## ${heading}${gap}${begin}\n${content}\n${end}\n\n`;
  const own = headingRange(text, heading);
  if (own) return text.slice(0, own.start) + block + text.slice(own.end).replace(/^\n+/, '');
  const prev = afterHeading ? headingRange(text, afterHeading) : null;
  const marker = afterMarker ? text.indexOf(afterMarker) : -1;
  const r = frontMatterRange(text);
  const at = prev ? prev.end : marker >= 0 ? marker + afterMarker.length : r ? r.end : 0;
  const before = text.slice(0, at).replace(/\n*$/, '\n\n');
  return before + block + text.slice(at).replace(/^\n+/, '');
}

const DESCRIPTION = { begin: '<!-- SECTION:DESCRIPTION:BEGIN -->', end: '<!-- SECTION:DESCRIPTION:END -->', heading: 'Description', gap: '\n\n' };
const ACCEPTANCE = { begin: '<!-- AC:BEGIN -->', end: '<!-- AC:END -->', heading: 'Acceptance Criteria', afterHeading: 'Description', afterMarker: '<!-- SECTION:DESCRIPTION:END -->', gap: '\n' }; // as Backlog.md writes them

// Backlog.md moves cards out of tasks/: their ids stay taken.
const ID_DIRS = ['tasks', 'completed', 'drafts', 'archive/tasks', 'archive/drafts'];

export function createTracker(root, trackerConfig) {
  const dir = path.join(root, trackerConfig.dir || 'backlog');
  const tasksDir = path.join(dir, 'tasks');

  function files() {
    if (!fs.existsSync(tasksDir)) throw new OrchError(`no Backlog.md tasks folder at ${tasksDir}`);
    return fs.readdirSync(tasksDir).filter(f => f.endsWith('.md')).map(f => path.join(tasksDir, f));
  }

  // Every id Backlog.md still holds, in tasks/ and in the folders it moves cards to.
  function allIds() {
    const ids = [];
    for (const d of ID_DIRS.map(x => path.join(dir, x)).filter(x => fs.existsSync(x))) {
      for (const f of fs.readdirSync(d).filter(x => x.endsWith('.md'))) {
        const id = parseFrontMatter(fs.readFileSync(path.join(d, f), 'utf8')).data.id;
        if (id) ids.push(String(id));
      }
    }
    return ids;
  }

  function load(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); // a \r\n card reads like any other
    const { data, body } = parseFrontMatter(text);
    if (!data.id) return null;
    const ordinal = Number(data.ordinal);
    return {
      id: String(data.id), title: String(data.title ?? ''), status: String(data.status ?? ''),
      dependencies: asList(data.dependencies), ownedFiles: asList(data.modified_files), checks: asList(data.checks),
      harnesses: asList(data.harnesses), noTests: data.no_tests ? String(data.no_tests) : null,
      parent: data.parent_task_id ? String(data.parent_task_id) : null,
      priority: data.priority ? String(data.priority) : null, ordinal: Number.isFinite(ordinal) ? ordinal : null,
      kind: data.kind ? String(data.kind) : null, external: asList(data.external_flows), labels: asList(data.labels),
      file, body,
    };
  }

  function find(id) {
    const want = String(id).toUpperCase();
    const hits = files().map(load).filter(t => t && t.id.toUpperCase() === want);
    if (!hits.length) throw new OrchError(`task ${id} not found in ${tasksDir}`);
    if (hits.length > 1) throw new OrchError(`task ${id} is in ${hits.length} files: ${hits.map(h => path.basename(h.file)).join(', ')}`);
    return hits[0];
  }

  function edit(id, change) {
    const t = find(id);
    const text = fs.readFileSync(t.file, 'utf8');
    const next = change(text);
    if (next !== text) writeAtomic(t.file, next);
  }

  // Same date style as the file already uses: ISO ('2026-10-24T18:00:00Z') or Backlog.md's 'yyyy-mm-dd HH:MM'.
  function stamp(fm) {
    const iso = /^(created|updated)_date:.*\d{4}-\d\d-\d\dT/m.test(fm);
    const t = now();
    return iso ? `${t.slice(0, 16)}:00Z` : `${t.slice(0, 10)} ${t.slice(11, 16)}`;
  }

  return {
    kind: 'backlog-md',
    list() { return files().map(load).filter(Boolean).map(({ body, ...t }) => t); },
    get(id) {
      const t = find(id);
      return { ...t, description: section(t.body, 'description'), acceptance: section(t.body, 'acceptance'), plan: section(t.body, 'plan') };
    },
    setStatus(id, status) {
      const allowed = configuredStatuses(dir);
      if (allowed && !allowed.includes(status)) throw new OrchError(`status "${status}" is not in ${path.join(dir, 'config.yml')} (${allowed.join(', ')})`);
      edit(id, text => {
        const r = frontMatterRange(text);
        if (!r) throw new OrchError(`task ${id} has no front matter`);
        let fm = r.inner;
        const date = `updated_date: '${stamp(fm)}'`;
        fm = /^status:.*$/m.test(fm) ? fm.replace(/^status:.*$/m, () => `status: ${yamlScalar(status)}`) : `${fm}\nstatus: ${yamlScalar(status)}`;
        fm = /^updated_date:.*$/m.test(fm) ? fm.replace(/^updated_date:.*$/m, () => date)
          : /^created_date:.*$/m.test(fm) ? fm.replace(/^(created_date:.*)$/m, m => `${m}\n${date}`) : `${fm}\n${date}`;
        return text.slice(0, r.innerStart) + fm + text.slice(r.innerStart + r.inner.length);
      });
    },
    // New cards in the skill's format (lib/card.mjs), all or none: ids and files are planned first, nothing is
    // written if any file exists, and a failed write removes the cards this call wrote. A child of a parent gets
    // <parent>.<n>, any other card <task_prefix>-<n>: the next number free in every folder Backlog.md keeps cards in.
    create(cards, status) {
      const tasks = files().map(load).filter(Boolean);
      const taken = allIds();
      const cfgFile = path.join(dir, 'config.yml');
      const prefix = (fs.existsSync(cfgFile) && fs.readFileSync(cfgFile, 'utf8').match(/^task_prefix:\s*["']?([^"'\s#]+)/m)?.[1]) || 'TASK';
      const sample = tasks[0] ? frontMatterRange(fs.readFileSync(tasks[0].file, 'utf8'))?.inner ?? '' : '';
      let ordinal = Math.max(-Infinity, ...tasks.map(t => t.ordinal).filter(Number.isFinite));
      const next = (re, make) => {
        const n = Math.max(0, ...taken.map(t => Number(t.match(re)?.[1] ?? 0))) + 1;
        const id = make(n); taken.push(id); return id;
      };
      const planned = cards.map(card => {
        let id;
        if (card.parent) {
          const p = tasks.find(t => t.id.toUpperCase() === card.parent.toUpperCase());
          if (!p) throw new OrchError(`parent ${card.parent} not found`);
          id = next(new RegExp(`^${escapeRe(p.id)}\\.(\\d+)$`, 'i'), n => `${p.id}.${n}`);
          card = { ...card, parent: p.id };
        } else id = next(new RegExp(`^${escapeRe(prefix)}-(\\d+)$`, 'i'), n => `${prefix.toUpperCase()}-${n}`);
        if (Number.isFinite(ordinal)) ordinal += 1000;
        const fm = [
          `id: ${id}`, ...renderKey('title', card.title), `status: ${yamlScalar(status)}`, 'assignee: []', `created_date: '${stamp(sample)}'`,
          ...CARD_KEYS.slice(1).filter(([k, get]) => ALWAYS.has(k) || !isEmpty(get(card))).flatMap(([k, get]) => renderKey(k, get(card))),
          ...(Number.isFinite(ordinal) ? [`ordinal: ${ordinal}`] : []),
        ];
        const text = `---\n${fm.join('\n')}\n---\n\n## Description\n\n${DESCRIPTION.begin}\n${card.goal}\n${DESCRIPTION.end}\n\n`
          + `## Acceptance Criteria\n${ACCEPTANCE.begin}\n${acLines(card)}\n${ACCEPTANCE.end}\n`;
        return { id, file: path.join(tasksDir, `${id.toLowerCase()} - ${slug(card.title)}.md`), text };
      });
      const clash = planned.find(p => fs.existsSync(p.file));
      if (clash) throw new OrchError(`${path.basename(clash.file)} already exists: nothing written`);
      const written = [];
      try {
        for (const p of planned) { writeAtomic(p.file, p.text); written.push(p.file); }
      } catch (e) {
        for (const f of written) fs.rmSync(f, { force: true });
        throw new OrchError(`writing the cards failed (${e.message}): nothing written`);
      }
      return planned.map(({ id, file }) => ({ id, file }));
    },
    // Rewrites the card's own fields and its Description and Acceptance Criteria; every other line stays as it was.
    update(id, card) {
      edit(id, original => {
        // Worked on with \n; a file written with \r\n gets \r\n back on every line.
        const crlf = original.includes('\r\n');
        const text = crlf ? original.replace(/\r\n/g, '\n') : original;
        const oldAc = between(text, ACCEPTANCE.begin, ACCEPTANCE.end) ?? byHeading(text, ACCEPTANCE.heading) ?? '';
        const ticked = new Set(oldAc.split('\n').map(l => l.match(/^\s*-\s*\[[xX]\]\s*(?:#\d+\s+)?(.*)$/)?.[1]).filter(Boolean).map(norm));
        const r = frontMatterRange(text);
        if (!r) throw new OrchError(`task ${id} has no front matter`);
        const blocks = keyBlocks(r.inner);
        for (const [k, get] of CARD_KEYS) {
          const v = get(card);
          const lines = !ALWAYS.has(k) && isEmpty(v) ? [] : renderKey(k, v);
          const at = blocks.findIndex(b => b.key === k);
          if (at >= 0) blocks.splice(at, 1, ...(lines.length ? [{ key: k, lines }] : []));
          else if (lines.length) {
            const before = blocks.findIndex(b => b.key === 'ordinal');
            blocks.splice(before >= 0 ? before : blocks.length, 0, { key: k, lines });
          }
        }
        let fm = blocks.flatMap(b => b.lines).join('\n');
        const date = `updated_date: '${stamp(fm)}'`;
        fm = /^updated_date:.*$/m.test(fm) ? fm.replace(/^updated_date:.*$/m, () => date)
          : /^created_date:.*$/m.test(fm) ? fm.replace(/^(created_date:.*)$/m, m => `${m}\n${date}`) : `${fm}\n${date}`;
        let out = text.slice(0, r.innerStart) + fm + text.slice(r.innerStart + r.inner.length);
        out = setSection(out, DESCRIPTION, card.goal);
        out = setSection(out, ACCEPTANCE, acLines(card, ticked));
        return crlf ? out.replace(/\n/g, '\r\n') : out;
      });
    },
    // One short line in Implementation Notes. Long text belongs in the run folder, not in the task.
    comment(id, line) {
      const clean = String(line).replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim().slice(0, 300);
      const entry = `- ${now().slice(0, 16).replace('T', ' ')} orch: ${clean}`;
      edit(id, text => {
        const end = '<!-- SECTION:NOTES:END -->';
        const at = text.indexOf(end);
        if (at >= 0) {
          const before = text.slice(0, at);
          return `${before}${before.endsWith('\n') ? '' : '\n'}${entry}\n${text.slice(at)}`;
        }
        const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
        return `${text}${sep}## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n${entry}\n${end}\n`;
      });
    },
  };
}
