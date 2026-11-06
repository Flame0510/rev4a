#!/usr/bin/env node
// release-diff.mjs --from <version> --to <version> [--notes] [--offline] [--work <dir>] [--packages <dir>] [--out <file.md>]
//
// Static comparison of two published OpenClaw releases, before any container runs them.
// Downloads `openclaw@<v>` (about 270 MB unpacked each) and `@openclaw/codex@<v>` into a cache
// (reused only when a previous extraction finished: a `<name>-<version>.complete` marker), then
// writes release-diff.md (for people) and release-diff.json (facts for rev4a-deps.mjs and
// triage.mjs):
//   - Node requirement (engines, security floors) and every `*SCHEMA_VERSION` constant, old → new
//     (a higher agent schema is a one-way migration: the old release refuses it). The state
//     database version (state/openclaw.sqlite user_version) is NOT a constant: compare.mjs reads it;
//   - bundled skills and plugins added or removed; @openclaw/codex versions with BOTH releases'
//     `openclaw` peer range and `@openai/codex` dependency (the codex line is always printed;
//     "not fetched: <reason>" when it could not be);
//   - CLI reference pages: removed pages, and flags Rev4a runs (references/deps.json `cli`) that a
//     page no longer documents; other changed pages are only counted;
//   - config keys documented with <ParamField>: no longer documented, changed type or default,
//     with the inventory id when Rev4a reads or writes the key;
//   - the OpenClaw internals Rev4a loads by name (names read from the Rev4a code, as the code
//     matches them: any exported function whose `.name` is the one Rev4a looks for), exported or
//     not, deprecated or not, and whether the deprecation is new;
//   - RETIRED_*, LEGACY_*, DEPRECATED_*, REMOVED_*, OBSOLETE_* and SYSTEM_OWNED_* declarations
//     new, gone or with a CHANGED VALUE (a retirement list that grows keeps its name), each with
//     the strings in it that Rev4a's code names;
//   - doc lines new in the target that announce a retirement, removal, rename, new default or
//     migration, those about an inventory area first (with the ids), the rest folded;
//   - with --notes (needs `gh`), every GitHub release body after FROM up to TO, hotfixes (`-N`)
//     included, and the lines in them about an inventory area.
// Fails loudly: npm or gh unreachable is an error (exit 1), never "not published" or "no notes".
// --offline uses the cache only and records what it could not check.
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, Untrustworthy, assertOutsideGit, baseDir, compareVersions, gitGrep, githubReleaseBodies, githubReleaseChangelog, loadDeps, main, repoRoot, run,
  versionParts, workDir, writeReport,
} from './lib.mjs';

const USAGE = `usage: release-diff.mjs --from <version> --to <version> [options]

  --notes            save every GitHub release body after FROM up to TO (needs gh, signed in)
  --offline          no npm or gh: use the package cache only (codex, dist-tags and notes are then "not checked")
  --work <dir>       run directory for the report (default $REV4A_UPGRADE_WORK/run or <tmpdir>/rev4a-openclaw-upgrade/run)
  --packages <dir>   download cache (default <base>/releases)
  --out <file.md>    report path (default <work>/release-diff.md); release-diff.json is written next to it
  --repo <dir>       the Rev4a checkout to grep (default: the one holding this script)

Exit: 0 report written; 1 usage/env error (npm/gh unreachable, package missing offline); 2 notes requested but none found.`;
const SPEC = { from: 'string', to: 'string', notes: 'boolean', offline: 'boolean', work: 'string', packages: 'string', out: 'string', repo: 'string' };

// Strong phrasing only: "migration" or "deprecated" alone appear in hundreds of unrelated lines.
const BEHAVIOUR = /\b(is retired|are retired|was retired|retired:|(was|were|has been|have been) removed|no longer|renamed to|now defaults?|defaults? (is now|changed)|breaking change|upgrading from|on upgrade|replaced by|stay registered but return an error|final compatibility day)\b/i;
// Doc areas about OpenClaw's own development or other platforms; never about what Rev4a runs.
const SKIP_DOCS = /^(ci|specs|platforms|help|web|architecture|announcements|maturity)\/|^(AGENTS|docs_map|logging|prose)\.md$/;
const NOTE_WORDS = /breaking|migrat|removed|deprecat|retired|renamed|no longer/i;
const CONST_PREFIXES = 'RETIRED_|LEGACY_|DEPRECATED_|REMOVED_|OBSOLETE_|SYSTEM_OWNED_';

await main(USAGE, SPEC, async (args) => {
  const { from, to } = args;
  if (!from || !to) throw new UsageError(`--from and --to are required\n\n${USAGE}`);
  for (const v of [from, to]) if (!versionParts(v)) throw new UsageError(`"${v}" is not an OpenClaw version (YYYY.M.D or YYYY.M.D-N)`);
  const repo = repoRoot(args.repo);
  const deps = loadDeps();
  const offline = !!args.offline;
  const packages = path.resolve(args.packages ?? baseDir('releases'));
  assertOutsideGit(packages);
  fs.mkdirSync(packages, { recursive: true });
  const outMd = args.out ? path.resolve(args.out) : path.join(workDir(args), 'release-diff.md');

  /**
   * `{ dir }` of `<pkg>@<version>` extracted under packages/<name>-<version>/package, or
   * `{ dir: null, reason }`. Only npm's E404 means "not published"; any other npm failure throws.
   */
  function fetchPackage(pkg, version, name) {
    const dir = path.join(packages, `${name}-${version}`);
    const marker = path.join(packages, `${name}-${version}.complete`);
    if (fs.existsSync(marker) && fs.existsSync(path.join(dir, 'package', 'package.json'))) return { dir: path.join(dir, 'package') };
    if (offline) return { dir: null, reason: `not in the cache ${packages} (no ${path.basename(marker)})` };
    const view = run('npm', ['view', `${pkg}@${version}`, 'version', '--json'], { timeoutMs: 60_000 });
    if (view.missing) throw new UsageError('npm is not installed: install it, or use --offline with a filled cache');
    if (view.rc !== 0) {
      if (/E404|404 Not Found|is not in this registry/i.test(view.out)) return { dir: null, reason: 'not published' };
      throw new UsageError(`npm view ${pkg}@${version} failed (rc ${view.rc}), not a "not published" answer: ${view.out.slice(-300)}`);
    }
    if (!view.stdout.trim()) return { dir: null, reason: 'not published (no such version)' };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.error(`downloading ${pkg}@${version} …`);
    const pack = run('npm', ['pack', `${pkg}@${version}`, '--pack-destination', dir, '--silent'], { timeoutMs: 1_800_000 });
    if (pack.rc !== 0) throw new UsageError(`npm pack ${pkg}@${version} failed: ${pack.out.slice(-400)}`);
    const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    const x = run('tar', ['xzf', path.join(dir, tgz), '-C', dir], { timeoutMs: 600_000 });
    if (x.rc !== 0) throw new UsageError(`extracting ${tgz} failed: ${x.out.slice(-400)}`);
    fs.rmSync(path.join(dir, tgz));
    fs.writeFileSync(marker, new Date().toISOString());
    return { dir: path.join(dir, 'package') };
  }

  const pa = fetchPackage('openclaw', from, 'openclaw');
  const pb = fetchPackage('openclaw', to, 'openclaw');
  if (!pa.dir || !pb.dir) throw new UsageError(`openclaw@${pa.dir ? to : from}: ${(pa.dir ? pb : pa).reason}`);
  const A = pa.dir; const B = pb.dir;
  const ca = fetchPackage('@openclaw/codex', from, 'codex');
  const cb = fetchPackage('@openclaw/codex', to, 'codex');

  const facts = { from, to, offline, packages: { from: A, to: B, codexFrom: ca.dir, codexTo: cb.dir } };
  const lines = [];
  const out = (s = '') => lines.push(s);
  const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const listDiff = (a, b) => ({ a: a.length, b: b.length, removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) });
  const printDiff = (title, d) => {
    out(`- ${title}: ${d.a} → ${d.b}`);
    if (d.removed.length) out(`  - **removed:** ${d.removed.join(', ')}`);
    if (d.added.length) out(`  - added: ${d.added.join(', ')}`);
  };
  // Every .js/.mjs under dist/, recursively: bundled plugins keep their own code in dist/extensions.
  const distCache = new Map();
  const distFiles = (root) => {
    if (distCache.has(root)) return distCache.get(root);
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.m?js$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(root, 'dist'));
    distCache.set(root, files);
    return files;
  };
  /** name → { file, value } for `const|let|var NAME = <value>;`, the value read to its end (brackets balanced). */
  const declarations = (root, nameRe) => {
    const m = new Map();
    for (const f of distFiles(root)) {
      const t = readText(f);
      for (const x of t.matchAll(new RegExp(`\\b(?:const|let|var)\\s+((?:${nameRe})[A-Z0-9_]*)\\s*=\\s*`, 'g'))) {
        if (m.has(x[1])) continue;
        let i = x.index + x[0].length; let depth = 0; let v = ''; let str = null;
        for (; i < t.length && v.length < 20000; i++) {
          const c = t[i];
          if (str) { v += c; if (c === '\\') { v += t[++i] ?? ''; continue; } if (c === str) str = null; continue; }
          if (c === '"' || c === "'" || c === '`') { str = c; v += c; continue; }
          if ('[{('.includes(c)) depth++;
          if (']})'.includes(c)) depth--;
          if ((c === ';' || c === ',' || c === '\n') && depth <= 0) break;
          v += c;
        }
        m.set(x[1], { file: path.relative(root, f), value: v.replace(/\s+/g, ' ').trim() });
      }
    }
    return m;
  };

  out(`# OpenClaw ${from} → ${to}: static comparison`);
  out();

  // ── Runtime requirements ─────────────────────────────────────
  out('## Runtime requirements');
  out();
  const pj = (root) => JSON.parse(readText(path.join(root, 'package.json')) || '{}');
  const floors = (root) => (readText(path.join(root, 'node-version.mjs')).match(/NODE_SECURITY_RELEASE_FLOORS = \[[\s\S]*?\];/)?.[0] ?? 'none').replace(/\s+/g, ' ');
  facts.engines = { from: pj(A).engines?.node ?? null, to: pj(B).engines?.node ?? null };
  facts.floors = { from: floors(A), to: floors(B) };
  out(`- engines.node: \`${facts.engines.from}\` → \`${facts.engines.to}\`${facts.engines.from !== facts.engines.to ? ' — **changed**' : ''}`);
  out(`- Node security floors: \`${facts.floors.from}\` → \`${facts.floors.to}\`${facts.floors.from !== facts.floors.to ? ' — **changed**' : ''}`);
  out('  - Whether a floor refuses to start or only warns is in node-version.mjs / openclaw.mjs: read it, release notes have been wrong about it.');
  const schemaConsts = (root) => {
    const m = new Map();
    for (const f of distFiles(root)) for (const x of readText(f).matchAll(/\b([A-Z][A-Z0-9_]*SCHEMA_VERSION)\s*=\s*(\d+)/g)) {
      const cur = m.get(x[1]) ?? new Set(); cur.add(Number(x[2])); m.set(x[1], cur);
    }
    return m;
  };
  const sa = schemaConsts(A); const sb = schemaConsts(B);
  facts.schemaVersions = [...new Set([...sa.keys(), ...sb.keys()])].sort().map((name) => ({ name, from: sa.has(name) ? [...sa.get(name)].sort((x, y) => x - y) : null, to: sb.has(name) ? [...sb.get(name)].sort((x, y) => x - y) : null }))
    .map((r) => ({ ...r, changed: JSON.stringify(r.from) !== JSON.stringify(r.to) }));
  out('- Schema version constants (a higher agent schema is one-way: the old release refuses the migrated database). The state database version is not a constant: compare.mjs reads it from `file.db-versions`.');
  out('');
  out('  | Constant | FROM | TO |');
  out('  |---|---|---|');
  for (const r of facts.schemaVersions) out(`  | \`${r.name}\` | ${r.from?.join(', ') ?? '–'} | ${r.to?.join(', ') ?? '–'}${r.changed ? ' **changed**' : ''} |`);
  out();

  // ── Bundled content ──────────────────────────────────────────
  out('## Bundled content');
  out();
  facts.bundledSkills = listDiff(ls(path.join(A, 'skills')), ls(path.join(B, 'skills')));
  facts.bundledPlugins = listDiff(ls(path.join(A, 'dist', 'extensions')), ls(path.join(B, 'dist', 'extensions')));
  printDiff('Bundled skills (Rev4a disables some by name in skills.entries)', facts.bundledSkills);
  printDiff('Bundled plugins (channels are plugins)', facts.bundledPlugins);
  printDiff('Top-level files', listDiff(ls(A), ls(B)));
  const codexFacts = (p) => (p.dir ? { version: pj(p.dir).version, peer: pj(p.dir).peerDependencies?.openclaw ?? null, codex: pj(p.dir).dependencies?.['@openai/codex'] ?? null } : { notFetched: p.reason });
  facts.codex = { from: codexFacts(ca), to: codexFacts(cb) };
  const codexText = (c) => (c.notFetched ? `not fetched: ${c.notFetched}` : `${c.version} (peer openclaw \`${c.peer ?? '-'}\`, @openai/codex \`${c.codex ?? '-'}\`)`);
  facts.codex.changed = !facts.codex.from.notFetched && !facts.codex.to.notFetched
    ? facts.codex.from.peer !== facts.codex.to.peer || facts.codex.from.codex !== facts.codex.to.codex : null;
  out(`- @openclaw/codex: ${codexText(facts.codex.from)} → ${codexText(facts.codex.to)}${facts.codex.changed ? ' — **peer range or @openai/codex changed**' : ''}`);
  out('  - The codex plugin is installed on the agent VOLUME, not in the image: check its version inside the agent after the update.');
  if (!offline) {
    const tags = run('npm', ['view', 'openclaw', 'dist-tags', '--json'], { timeoutMs: 60_000 });
    if (tags.rc !== 0) throw new UsageError(`npm view openclaw dist-tags failed: ${tags.out.slice(-300)}`);
    try { facts.distTags = JSON.parse(tags.stdout); } catch { throw new UsageError(`npm view openclaw dist-tags returned no JSON: ${tags.stdout.slice(0, 200)}`); }
    out(`- npm dist-tags: ${Object.entries(facts.distTags).map(([k, v]) => `${k} \`${v}\``).join(', ')}`);
  } else {
    facts.distTags = null;
    out('- npm dist-tags: not checked (--offline)');
  }
  out();

  // ── CLI pages ────────────────────────────────────────────────
  out('## CLI reference pages Rev4a depends on');
  out();
  const cliPages = (root) => {
    const base = path.join(root, 'docs', 'cli');
    const pages = [];
    const walk = (rel) => ls(path.join(base, rel)).forEach((e) => {
      const p = path.join(rel, e);
      if (fs.statSync(path.join(base, p)).isDirectory()) walk(p); else if (e.endsWith('.md')) pages.push(p.replace(/\.md$/, ''));
    });
    walk('');
    return pages.sort();
  };
  const pagesA = cliPages(A); const pagesB = cliPages(B);
  facts.cliPages = listDiff(pagesA, pagesB);
  printDiff('docs/cli pages (with subpages)', facts.cliPages);
  // The text of a command's page and its subpages (docs/cli/gateway/query.md documents `gateway call`).
  const pageText = (root, cmd) => pagesOfRoot(root).filter((p) => p === cmd || p.startsWith(`${cmd}/`)).map((p) => readText(path.join(root, 'docs', 'cli', `${p}.md`))).join('\n');
  const pagesOfRoot = (root) => (root === A ? pagesA : pagesB);
  const usedFlags = new Map();
  for (const c of deps.cli) {
    const cmd = c.argv[0];
    const set = usedFlags.get(cmd) ?? new Set();
    c.argv.filter((x) => x.startsWith('--')).forEach((f) => set.add(f));
    usedFlags.set(cmd, set);
  }
  const flagsIn = (t) => new Set(t.match(/--[a-z][a-z0-9-]+/g) ?? []);
  facts.cliRev4a = [];
  let quiet = 0;
  for (const [cmd, flags] of [...usedFlags].sort()) {
    const ta = pageText(A, cmd); const tb = pageText(B, cmd);
    const fa = flagsIn(ta); const fb = flagsIn(tb);
    const goneUsed = [...flags].filter((f) => fa.has(f) && !fb.has(f));
    const goneOther = [...fa].filter((f) => !fb.has(f) && !flags.has(f));
    const row = { command: cmd, page: !!tb, pageFrom: !!ta, flagsGoneUsedByRev4a: goneUsed, flagsGoneOther: goneOther, changed: ta !== tb };
    facts.cliRev4a.push(row);
    if (!tb && ta) out(`- **\`${cmd}\`: no page in TO** (Rev4a runs it)`);
    else if (goneUsed.length) out(`- **\`${cmd}\`: flags Rev4a uses no longer documented: ${goneUsed.join(' ')}**${goneOther.length ? `; other flags gone: ${goneOther.join(' ')}` : ''}`);
    else if (goneOther.length) out(`- \`${cmd}\`: flags Rev4a does not use are gone: ${goneOther.join(' ')}`);
    else if (row.changed) quiet++;
  }
  if (quiet) out(`- ${quiet} other Rev4a command page(s) changed without losing a flag (rev4a-deps.mjs checks every flag Rev4a runs).`);
  out();

  // ── Config keys and defaults ─────────────────────────────────
  // Keys as the reference docs declare them (<ParamField path=… type=… default=…>). A changed
  // default changes every agent that never set the key; an option that disappears from a key's
  // type (an approval mode, say) is lost by agents that chose it.
  out('## Config keys and defaults (from the reference docs)');
  out();
  const paramFields = (root) => {
    const m = new Map();
    const walk = (rel = '') => ls(path.join(root, 'docs', rel)).forEach((f) => {
      const p = path.join(rel, f);
      if (fs.statSync(path.join(root, 'docs', p)).isDirectory()) return walk(p);
      if (!f.endsWith('.md')) return;
      for (const x of readText(path.join(root, 'docs', p)).matchAll(/<ParamField\s+path="([^"]+)"([^>]*)>/g)) {
        const attr = (n) => x[2].match(new RegExp(`${n}=("[^"]*"|'[^']*'|\\{[^}]*\\})`))?.[1]?.replace(/^["'{]|["'}]$/g, '');
        m.set(x[1], { type: attr('type') ?? '', def: attr('default') ?? '', doc: p });
      }
    });
    walk();
    return m;
  };
  const pfA = paramFields(A); const pfB = paramFields(B);
  // Inventory ids of the config keys Rev4a reads or writes, by path without `[]` and `<key>`.
  const depKey = (k) => deps.configKeys.filter((c) => c.paths.some((p) => { const q = p.replace(/\[\]/g, ''); return q === k || q.startsWith(`${k}.`) || k.startsWith(`${q}.`); })).map((c) => c.id);
  facts.paramFields = { gone: [], changed: [], added: 0 };
  for (const [k, a] of [...pfA].sort()) {
    const b = pfB.get(k);
    const ids = [...new Set(depKey(k))];
    if (!b) facts.paramFields.gone.push({ key: k, type: a.type, def: a.def, inventory: ids });
    else if (a.def !== b.def || a.type !== b.type) facts.paramFields.changed.push({ key: k, typeFrom: a.type, typeTo: b.type, defFrom: a.def, defTo: b.def, doc: b.doc, inventory: ids });
  }
  facts.paramFields.added = [...pfB.keys()].filter((k) => !pfA.has(k)).length;
  for (const g of facts.paramFields.gone) out(`- **no longer documented:** \`${g.key}\` (was type \`${g.type}\`, default \`${g.def}\`)${g.inventory.length ? ` — **Rev4a uses it (${g.inventory.join(', ')})**` : ''}`);
  for (const c of facts.paramFields.changed) out(`- changed: \`${c.key}\` type \`${c.typeFrom}\` → \`${c.typeTo}\`, default \`${c.defFrom}\` → \`${c.defTo}\` (docs/${c.doc})${c.inventory.length ? ` — **Rev4a uses it (${c.inventory.join(', ')})**` : ''}`);
  if (facts.paramFields.added) out(`- ${facts.paramFields.added} new documented key(s); schema-diff.mjs lists the ones with a default.`);
  if (!facts.paramFields.gone.length && !facts.paramFields.changed.length) out('No documented key disappeared or changed.');
  out('- Only keys documented with <ParamField> are covered: before stating that a default changed, read the old release\'s doc for the same key.');
  out();

  // ── Internals Rev4a loads by name ────────────────────────────
  out('## OpenClaw internals Rev4a loads by name');
  out();
  facts.internals = [];
  for (const imp of deps.internals) {
    const src = readText(path.join(repo, imp.namesFrom.file));
    const names = [...new Set([...src.matchAll(new RegExp(imp.namesFrom.pattern, 'g'))].map((m) => m[1]))];
    if (!names.length) throw new UsageError(`no names matched ${imp.namesFrom.pattern} in ${imp.namesFrom.file}: update references/deps.json internals`);
    const glob = new RegExp(imp.fileGlob);
    const find = (root, name) => {
      for (const f of ls(path.join(root, 'dist')).filter((x) => glob.test(x))) {
        const t = readText(path.join(root, 'dist', f));
        // Function.name is the declared name for `function NAME` and for `const NAME = (async) (…) =>`.
        const decl = new RegExp(`(?:function\\s*\\*?\\s*${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>))`).exec(t);
        if (!decl) continue;
        const exported = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}|export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+(?:const|let)\\s+${name}\\b`).test(t);
        const dep = t.slice(Math.max(0, decl.index - 400), decl.index).match(/@deprecated[^\n]*/g)?.pop()?.replace(/\*\/.*/, '').trim() ?? null;
        return { file: f, exported, deprecated: dep };
      }
      return null;
    };
    for (const name of names) {
      const b = find(B, name); const a = find(A, name);
      const row = { id: imp.id, name, user: imp.user, found: !!b, file: b?.file ?? null, exported: b?.exported ?? false, deprecated: b?.deprecated ?? null, deprecatedInFrom: a?.deprecated ?? null };
      row.deprecationNew = !!row.deprecated && row.deprecated !== row.deprecatedInFrom;
      facts.internals.push(row);
      if (!b) out(`- **\`${name}\` not found** in dist/${imp.fileGlob} — breaks ${imp.user}`);
      else out(`- \`${name}\`: in \`${b.file}\`, ${b.exported ? 'exported' : '**not exported**'}${row.deprecated ? `; **${row.deprecated}**${row.deprecationNew ? ' (new or changed since FROM)' : ' (same as FROM)'}` : ''} — ${imp.user}`);
    }
  }
  out('- This is a static reading. The real check runs Rev4a\'s import loop in the TO image: `rev4a-deps.mjs --to-image`.');
  out();

  // ── Retirement and legacy constants ──────────────────────────
  out('## Retirement, legacy and system-owned constants');
  out();
  out('New, gone, or with a changed value. A changed value is how a retirement list grows without a new name (2026.10: the `skill-collection-review:` cron rows that broke the update verification). "Rev4a names" lists strings in the value that appear in the Rev4a code.');
  out();
  const ra = declarations(A, CONST_PREFIXES); const rb = declarations(B, CONST_PREFIXES);
  const grepCache = new Map();
  let greps = 0;
  const rev4aNames = (value) => {
    const hits = [];
    // Candidates: config paths written as segment arrays (["agents", "list"] → agents.list) and
    // identifier-like strings with punctuation (skill-collection-review:, a.b.c). Single words
    // ("tools", "agents") hit unrelated code everywhere and are not searched.
    const segPaths = [...value.matchAll(/\[\s*((?:"[\w-]+"\s*,\s*)+"[\w-]+")\s*\]/g)].map((m) => [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]).join('.'));
    const strings = [...value.matchAll(/["'`]([^"'`\s$]{6,80})["'`]/g)].map((m) => m[1]).filter((x) => /[.:/-]/.test(x) && /^[\w.:/-]+$/.test(x));
    for (const s of new Set([...segPaths, ...strings])) {
      if (!grepCache.has(s)) {
        if (greps++ > 400) break;
        // Code only: a word in a template's prose is not a dependency.
        grepCache.set(s, gitGrep(repo, s, { filesOnly: true }).filter((f) => !/\.md$/.test(f)));
      }
      if (grepCache.get(s).length) hits.push(`${s} (${grepCache.get(s).slice(0, 2).join(', ')})`);
    }
    return hits;
  };
  facts.constants = { new: [], gone: [], changed: [] };
  for (const [name, d] of rb) {
    if (!ra.has(name)) facts.constants.new.push({ name, file: d.file, value: d.value.slice(0, 600), rev4aNames: rev4aNames(d.value) });
    else if (ra.get(name).value !== d.value) facts.constants.changed.push({ name, file: d.file, from: ra.get(name).value.slice(0, 600), to: d.value.slice(0, 600), rev4aNames: rev4aNames(d.value) });
  }
  for (const [name, d] of ra) if (!rb.has(name)) facts.constants.gone.push({ name, file: d.file });
  const show = (v) => `\`${v.slice(0, 220).replace(/`/g, "'")}${v.length > 220 ? '…' : ''}\``;
  const retiredFirst = (x, y) => (/^(RETIRED|SYSTEM_OWNED)_/.test(y.name) ? 1 : 0) - (/^(RETIRED|SYSTEM_OWNED)_/.test(x.name) ? 1 : 0) || x.name.localeCompare(y.name);
  // RETIRED_* and SYSTEM_OWNED_* (state OpenClaw deletes or owns), and any constant whose value
  // Rev4a names, are shown; the other LEGACY_*/DEPRECATED_* churn is folded.
  const loud = (c) => /^(RETIRED|SYSTEM_OWNED)_/.test(c.name) || c.rev4aNames.length;
  const rowNew = (c) => `- new \`${c.name}\` (\`${c.file}\`): ${show(c.value)}${c.rev4aNames.length ? ` — **Rev4a names:** ${c.rev4aNames.join('; ')}` : ''}`;
  const rowChanged = (c) => `- **value changed** \`${c.name}\` (\`${c.file}\`): ${show(c.from)} → ${show(c.to)}${c.rev4aNames.length ? ` — **Rev4a names:** ${c.rev4aNames.join('; ')}` : ''}`;
  for (const c of facts.constants.new.filter(loud).sort(retiredFirst)) out(rowNew(c));
  for (const c of facts.constants.changed.filter(loud).sort(retiredFirst)) out(rowChanged(c));
  const quietNew = facts.constants.new.filter((c) => !loud(c)); const quietChanged = facts.constants.changed.filter((c) => !loud(c));
  if (quietNew.length || quietChanged.length || facts.constants.gone.length) {
    out();
    out(`<details><summary>${quietNew.length} new, ${quietChanged.length} changed and ${facts.constants.gone.length} gone LEGACY_/DEPRECATED_/REMOVED_/OBSOLETE_ constant(s) that Rev4a does not name</summary>`);
    out();
    for (const c of quietNew.sort(retiredFirst)) out(rowNew(c));
    for (const c of quietChanged.sort(retiredFirst)) out(rowChanged(c));
    if (facts.constants.gone.length) out(`- gone: ${facts.constants.gone.map((c) => `\`${c.name}\``).join(', ')}`);
    out();
    out('</details>');
    out();
  }
  if (!facts.constants.new.length && !facts.constants.changed.length && !facts.constants.gone.length) out('None.');
  out('- Each one may delete or ignore state Rev4a counts or shows.');
  out();

  // ── Behaviour changes in the docs ────────────────────────────
  out('## Behaviour changes stated in the target docs');
  out();
  out('Doc lines new in the target that say something was retired, removed, renamed, migrated or now defaults to something. Lines about an inventory area come first, with the ids; read each in context.');
  out();
  const areaIds = (text) => {
    const t = text.toLowerCase();
    return [...new Set(Object.entries(deps.areas).filter(([k]) => t.includes(k)).flatMap(([, ids]) => ids))].sort();
  };
  const walkDocs = (root, rel = '') => ls(path.join(root, rel)).flatMap((f) => {
    const p = path.join(rel, f);
    return fs.statSync(path.join(root, p)).isDirectory() ? walkDocs(root, p) : (f.endsWith('.md') ? [p] : []);
  });
  facts.behaviour = [];
  const other = new Map();
  for (const rel of walkDocs(path.join(B, 'docs')).filter((r) => !SKIP_DOCS.test(r))) {
    const oldLines = new Set(readText(path.join(A, 'docs', rel)).split('\n').map((l) => l.trim()));
    const hits = readText(path.join(B, 'docs', rel)).split('\n').map((l) => l.trim())
      .filter((l) => l && !oldLines.has(l) && BEHAVIOUR.test(l) && !/^\|?\s*-{3}/.test(l));
    for (const h of hits) {
      const ids = areaIds(`${rel} ${h}`);
      facts.behaviour.push({ file: `docs/${rel}`, line: h.slice(0, 400), inventory: ids });
      if (!ids.length) other.set(rel, (other.get(rel) ?? 0) + 1);
    }
  }
  const ranked = facts.behaviour.filter((b) => b.inventory.length);
  for (const b of ranked) out(`- **${b.inventory.join(', ')}** \`${b.file}\`: ${b.line.slice(0, 300)}`);
  if (!ranked.length) out('No new line about an inventory area.');
  if (other.size) {
    out();
    out(`<details><summary>${[...other.values()].reduce((x, y) => x + y, 0)} other line(s) in ${other.size} file(s), no inventory area named</summary>`);
    out();
    for (const b of facts.behaviour.filter((x) => !x.inventory.length)) out(`- \`${b.file}\`: ${b.line.slice(0, 300)}`);
    out();
    out('</details>');
  }
  out();

  // ── Release notes ────────────────────────────────────────────
  facts.notes = { requested: !!args.notes, fetched: false, reason: null, bodies: [], hits: [] };
  if (args.notes && offline) facts.notes.reason = 'not fetched: --offline';
  else if (args.notes) {
    const notesDir = path.join(path.dirname(outMd), `notes-${from}-${to}`);
    fs.mkdirSync(notesDir, { recursive: true });
    const releases = githubReleaseBodies();
    const tags = releases.map((r) => r.tag);
    // Four-part comparison: a `-N` hotfix is after its base release (Rev4a's compareVersions).
    const between = tags.filter((t) => /^v?\d+\.\d+\.\d+(-\d+)?$/.test(t) && compareVersions(t, from) > 0 && compareVersions(t, to) <= 0).sort(compareVersions);
    for (const t of between) {
      let body = releases.find((r) => r.tag === t).body;
      const changelog = githubReleaseChangelog(t, body);
      if (changelog !== null) {
        fs.writeFileSync(path.join(notesDir, `${t.replace(/^v/, '')}.publication.md`), body);
        body = changelog;
      }
      fs.writeFileSync(path.join(notesDir, `${t.replace(/^v/, '')}.md`), body);
      for (const l of body.split('\n')) {
        if (!NOTE_WORDS.test(l)) continue;
        const ids = areaIds(l);
        if (ids.length) facts.notes.hits.push({ release: t, inventory: ids, line: l.trim().slice(0, 400) });
      }
    }
    Object.assign(facts.notes, { fetched: true, dir: notesDir, bodies: between, listedReleases: releases.length });
    if (!between.length && compareVersions(from, to) !== 0) {
      facts.notes.fetched = false;
      facts.notes.reason = `no release between ${from} and ${to} in the complete GitHub release list`;
    }
  } else facts.notes.reason = 'not requested (--notes)';
  out('## Release notes');
  out();
  if (facts.notes.fetched) {
    out(`Saved ${facts.notes.bodies.length} release bodies (${facts.notes.bodies.join(', ')}) to \`${facts.notes.dir}\`. Read all of them: the package CHANGELOG carries only the latest release.`);
    out();
    out(facts.notes.hits.length ? facts.notes.hits.map((h) => `- **${h.inventory.join(', ')}** ${h.release}: ${h.line.slice(0, 300)}`).join('\n') : 'No line about a breaking change, migration, removal or deprecation names an inventory area.');
  } else out(`**Not checked:** ${facts.notes.reason}.`);

  writeReport(outMd, lines.join('\n'), facts);
  if (args.notes && !offline && !facts.notes.fetched) throw new Untrustworthy(facts.notes.reason);
  return 0;
});
