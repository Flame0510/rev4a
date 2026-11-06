#!/usr/bin/env node
// rev4a-deps.mjs (--to-schema <file> | --to-image <image>) [options]
//
// Checks what Rev4a depends on (references/deps.json, a machine-readable subset of
// references/inventory.md) against the target release, so "every key Rev4a writes must still be
// there" and "every field Rev4a parses" are checked by a script, not by reading. Writes
// rev4a-deps.md and rev4a-deps.json:
//   C1 config keys Rev4a writes or reads, against the TO schema (and FROM's, to tell a new break
//      from an old one): named / through a map / under an open object (unchecked) / MISSING, and
//      every value Rev4a writes against the schema's enum there;
//   C2 JSON fields Rev4a parses, against the after-snapshot (and the before one): present / LOST
//      (in before, not after) / not comparable (an empty array above it) / not exercised;
//   C3 CLI commands, subcommands and flags Rev4a and these scripts run, against the TO reference
//      docs (docs/cli/<cmd>.md and its subpages); with --to-image also against
//      `openclaw <command> --help` in the image, with no network;
//   C4 config paths the TO release migrates or retires (legacyRules paths, RETIRED_*PATHS) that
//      the Rev4a code still names outside comments, each marked new in TO or already in FROM's set;
//   ids: hook ids, skill names and plugin ids Rev4a names, present in the TO package;
//   internals: the functions Rev4a imports from the TO dist by `.name` (lib/channelManager.ts);
//      with --to-image, Rev4a's own import loop runs inside the image (node, no network) — the
//      package is untrusted code, so it never runs on the host.
// Anything it cannot check is listed as "unverified" with the reason, never as passed.
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, checkFields, firstJson, flattenSchema, gitGrep, loadDeps, loadSchema, main, repoRoot, run,
  schemaLookup, shapeMap, workDir, writeReport,
} from './lib.mjs';

const USAGE = `usage: rev4a-deps.mjs (--to-schema <file> | --to-image <image>) [options]

  --from-schema <file> | --from-image <image>   FROM's schema, to tell a new break from an old one
  --snapshot <dir>            the after-snapshot (default <work>/snap-after when it exists)
  --before <dir>              the before-snapshot (default <work>/snap-before when it exists)
  --release-diff-json <file>  release-diff.json, for the package paths (default <work>/release-diff.json)
  --to-package <dir>          the extracted TO openclaw package, instead of release-diff.json
  --out <file.md>             report path (default <work>/rev4a-deps.md); rev4a-deps.json is written next to it
  --work <dir> | --repo <dir>

Exit: 0 report written (findings are in it); 1 usage/env error; 2 a schema could not be read.`;
const SPEC = {
  'to-schema': 'string', 'to-image': 'string', 'from-schema': 'string', 'from-image': 'string', snapshot: 'string', before: 'string',
  'release-diff-json': 'string', 'to-package': 'string', out: 'string', work: 'string', repo: 'string',
};

/** Shape maps of the items a snapshot read successfully, from their raw output. */
function snapshotShapes(dir) {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const items = Array.isArray(idx) ? idx : idx.items;
  const m = new Map();
  for (const it of items) {
    const okRc = it.ok ?? (it.rc === 0 || (it.rc >= 200 && it.rc < 300));
    if (!okRc || !it.json) continue;
    let v;
    try { v = firstJson(fs.readFileSync(path.join(dir, `${it.name}.raw`), 'utf8')); } catch { continue; }
    if (v !== undefined) m.set(it.name, shapeMap(v));
  }
  return { shapes: m, ok: Array.isArray(idx) ? null : idx.ok ?? null, formatVersion: Array.isArray(idx) ? 1 : idx.formatVersion ?? 1 };
}

await main(USAGE, SPEC, async (args) => {
  const toSrc = args['to-schema'] ? { file: args['to-schema'] } : args['to-image'] ? { image: args['to-image'] } : null;
  if (!toSrc) throw new UsageError(`--to-schema or --to-image is required\n\n${USAGE}`);
  const fromSrc = args['from-schema'] ? { file: args['from-schema'] } : args['from-image'] ? { image: args['from-image'] } : null;
  const repo = repoRoot(args.repo);
  const deps = loadDeps();
  const work = workDir(args);
  const outMd = args.out ? path.resolve(args.out) : path.join(work, 'rev4a-deps.md');
  const orDefault = (flag, name) => (args[flag] ? path.resolve(args[flag]) : fs.existsSync(path.join(work, name)) ? path.join(work, name) : null);
  const unverified = [];
  const facts = { to: toSrc.file ?? toSrc.image, from: fromSrc ? (fromSrc.file ?? fromSrc.image) : null, unverified };

  // ── C1 config keys ───────────────────────────────────────────
  const fb = flattenSchema(loadSchema(toSrc));
  const fa = fromSrc ? flattenSchema(loadSchema(fromSrc)) : null;
  facts.configKeys = [];
  for (const k of deps.configKeys) {
    for (const p of k.paths) {
      const to = schemaLookup(fb, p); const from = fa ? schemaLookup(fa, p) : null;
      const row = { id: k.id, mode: k.mode, path: p, to: to.status, from: from?.status ?? null, at: to.at ?? null };
      if (to.status === 'missing') row.result = k.retiredOk ? 'retired (Rev4a only removes it)' : from && from.status === 'missing' ? 'missing in FROM and TO'
        // Without FROM's schema a key absent from TO may never have existed: not a proven break.
        : from ? 'MISSING' : 'missing in TO (FROM not given: unverified)';
      else if (to.status === 'open') row.result = 'unchecked';
      else row.result = 'ok';
      // Values Rev4a writes must still be among the options of an enum there.
      const valuesPath = k.valuesAt ?? p;
      if (k.values && valuesPath === p && to.at) {
        const node = fb.get(to.at);
        if (node?.enum.size) {
          const lost = k.values.filter((v) => !node.enum.has(JSON.stringify(v)));
          if (lost.length) { row.result = 'VALUE NOT ACCEPTED'; row.valuesLost = lost; }
        }
      }
      facts.configKeys.push(row);
    }
  }

  // ── C2 fields ────────────────────────────────────────────────
  const after = orDefault('snapshot', 'snap-after');
  const before = orDefault('before', 'snap-before');
  if (after) {
    const B = snapshotShapes(after);
    const A = before ? snapshotShapes(before) : null;
    facts.snapshots = { after, before, afterOk: B.ok, afterFormat: B.formatVersion };
    if (B.ok === false) unverified.push(`the after-snapshot ${after} is marked ok:false: field results are partial`);
    facts.fields = checkFields(deps.fields, B.shapes, A?.shapes ?? null);
  } else {
    facts.fields = [];
    unverified.push('C2 fields: no after-snapshot (--snapshot, or <work>/snap-after)');
  }

  // ── Packages (C3, C4, ids, internals) ────────────────────────
  let toPkg = args['to-package'] ? path.resolve(args['to-package']) : null;
  let fromPkg = null;
  const rdFile = orDefault('release-diff-json', 'release-diff.json');
  if (rdFile) {
    const rd = JSON.parse(fs.readFileSync(rdFile, 'utf8'));
    toPkg ??= rd.packages?.to ?? null;
    fromPkg = rd.packages?.from ?? null;
  }
  if (toPkg && !fs.existsSync(path.join(toPkg, 'package.json'))) throw new UsageError(`${toPkg} is not an extracted openclaw package`);
  const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const cliPagesText = (root, cmd) => {
    if (!root) return null;
    const base = path.join(root, 'docs', 'cli');
    let t = readText(path.join(base, `${cmd}.md`));
    const walk = (d) => { for (const e of ls(d)) { const p = path.join(d, e); if (fs.statSync(p).isDirectory()) walk(p); else if (e.endsWith('.md')) t += `\n${readText(p)}`; } };
    walk(path.join(base, cmd));
    return t;
  };
  const distFiles = (root) => {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.m?js$/.test(e.name)) files.push(p); } };
    walk(path.join(root, 'dist'));
    return files;
  };

  // ── C3 CLI ───────────────────────────────────────────────────
  facts.cli = [];
  if (!toPkg) unverified.push('C3 CLI flags: no TO package (--to-package, or release-diff.json)');
  const helpCache = new Map();
  const help = (words) => {
    const key = words.join(' ');
    if (!helpCache.has(key)) {
      const r = run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'openclaw', toSrc.image, ...words, '--help'], { timeoutMs: 120_000 });
      helpCache.set(key, r.missing ? null : r.out);
    }
    return helpCache.get(key);
  };
  for (const c of deps.cli) {
    const words = c.argv.filter((x) => !x.startsWith('--'));
    const flags = c.argv.filter((x) => x.startsWith('--'));
    const row = { id: c.id, command: `openclaw ${c.argv.join(' ')}`, docs: null, help: null };
    if (toPkg) {
      const tb = cliPagesText(toPkg, words[0]); const ta = cliPagesText(fromPkg, words[0]);
      if (!tb) row.docs = { result: 'NO PAGE' };
      else {
        // `cron` subcommands are documented as `automations <sub>` (the command's alias).
        const has = (t, w) => new RegExp(`(^|[\\s\`'"|(])${w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?=[\\s\`'"|),.=:]|$)`, 'm').test(t);
        const missing = [...words.slice(1), ...flags].filter((w) => !has(tb, w));
        const gone = ta ? missing.filter((w) => has(ta, w)) : [];
        row.docs = { result: gone.length ? 'GONE' : missing.length ? 'undocumented' : 'ok', missing, gone };
      }
    }
    if (toSrc.image) {
      // `gateway` (C9) is the server command itself: its --help documents the flags.
      const h = help(words.slice(0, words[0] === 'gateway' && words.length === 1 ? 1 : Math.min(words.length, 3)));
      if (h === null) row.help = { result: 'unverified (docker not available)' };
      else {
        const missing = flags.filter((f) => !h.includes(f));
        row.help = { result: missing.length ? 'FLAG NOT IN --help' : 'ok', missing };
      }
    }
    facts.cli.push(row);
  }
  if (!toSrc.image) unverified.push('C3 live check: no --to-image, so `openclaw <command> --help` was not run (docs only)');

  // ── C4 retired / migrated config paths named by Rev4a ────────
  facts.legacy = [];
  /** Every config path a package's migration rules or RETIRED_*PATHS constants name. */
  const legacyPathsOf = (pkg) => {
    const paths = new Map();
    for (const f of distFiles(pkg)) {
      const t = readText(f);
      if (!/legacyRules|RETIRED_[A-Z_]*PATHS/.test(t)) continue;
      const add = (segs, src, msg = '') => { if (segs.length >= 2 && !paths.has(segs.join('.'))) paths.set(segs.join('.'), { src, msg, file: path.relative(pkg, f) }); };
      // `path: ["a", "b"]` inside migration rules (inline or in a constant referenced by name).
      for (const m of t.matchAll(/\bpath:\s*\[([^\]]*)\]([^}]{0,400}?message:\s*["'`]([^"'`]{0,160}))?/g)) {
        add([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), 'legacyRules', m[3] ?? '');
      }
      for (const m of t.matchAll(/const (RETIRED_[A-Z_]*PATHS) = \[([\s\S]*?)\];/g)) {
        for (const a of m[2].matchAll(/\[\s*("[^\]]+")\s*\]/g)) add([...a[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), m[1]);
      }
    }
    return paths;
  };
  // A code line, not a comment: `git grep -n` prints `file:line:text`.
  const isComment = (hit) => /^\s*(\/\/|\/\*|\*|#|<!--)/.test(hit.replace(/^[^:]+:\d+:/, ''));
  if (toPkg) {
    const paths = legacyPathsOf(toPkg);
    // FROM's own set: a path FROM already migrated or retired is not news (Rev4a lived with it on
    // FROM). Only a path new in TO escalates (triage T6); without FROM's package, `newInTo` is null.
    const fromPaths = fromPkg && fs.existsSync(path.join(fromPkg, 'package.json')) ? legacyPathsOf(fromPkg) : null;
    if (!fromPaths) unverified.push('C4 retired paths: no FROM package, so every path TO migrates counts as new');
    facts.legacyPaths = paths.size;
    facts.legacyPathsFrom = fromPaths ? fromPaths.size : null;
    for (const [p, info] of [...paths].sort()) {
      const segs = p.split('.');
      const needles = [...new Set([p, segs.slice(-2).join('.'), segs.slice(-2).join('?.')])];
      // The full path first; the last two segments catch `x?.y` and nested literals, and can hit
      // a different parent (the report shows which needle matched). Comment lines (a Dockerfile's
      // "# … is not set", a JSDoc line) only describe the path: they are not counted.
      let hits = []; let needle = null;
      for (const n of needles) { hits = gitGrep(repo, n).filter((l) => !/\.md:/.test(l) && !isComment(l)); if (hits.length) { needle = n; break; } }
      if (hits.length) facts.legacy.push({ path: p, ...info, needle, exact: needle === p, newInTo: fromPaths ? !fromPaths.has(p) : null, rev4a: hits.slice(0, 4) });
    }
  } else unverified.push('C4 retired paths: no TO package');

  // ── ids ──────────────────────────────────────────────────────
  facts.ids = [];
  if (toPkg) {
    const dist = distFiles(toPkg).map(readText);
    for (const i of deps.ids) {
      let found;
      if (i.kind === 'plugin') found = fs.existsSync(path.join(toPkg, 'dist', 'extensions', i.name)) || dist.some((t) => t.includes(`"${i.name}"`));
      else if (i.kind === 'skill') found = fs.existsSync(path.join(toPkg, 'skills', i.name)) || dist.some((t) => t.includes(`"${i.name}"`));
      else found = dist.some((t) => t.includes(`"${i.name}"`) || t.includes(`'${i.name}'`));
      facts.ids.push({ id: i.id, kind: i.kind, name: i.name, found });
    }
  } else unverified.push('ids: no TO package');

  // ── internals, live ──────────────────────────────────────────
  facts.internals = [];
  for (const imp of deps.internals) {
    const src = readText(path.join(repo, imp.namesFrom.file));
    const names = [...new Set([...src.matchAll(new RegExp(imp.namesFrom.pattern, 'g'))].map((m) => m[1]))];
    if (!names.length) throw new UsageError(`no names matched ${imp.namesFrom.pattern} in ${imp.namesFrom.file}: update references/deps.json internals`);
    if (!toSrc.image) { facts.internals.push({ id: imp.id, names, result: 'unverified (no --to-image)' }); continue; }
    // The same loop as Rev4a's PAIRING_STORE_SCRIPT: every export of every matching file, by `.name`.
    const script = `(async () => { const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
      const dist = '/usr/local/lib/node_modules/openclaw/dist'; const found = {};
      for (const f of fs.readdirSync(dist).filter((x) => new RegExp(${JSON.stringify(imp.fileGlob)}).test(x))) {
        try { const mod = await import(pathToFileURL(path.join(dist, f)).href);
          for (const v of Object.values(mod)) if (typeof v === 'function') found[v.name] = f; } catch (e) { found['error:' + f] = e.message; } }
      console.log(JSON.stringify(found)); })();`;
    const r = run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', toSrc.image, '-e', script], { timeoutMs: 180_000 });
    const found = firstJson(r.stdout) ?? {};
    const missing = names.filter((n) => !found[n]);
    facts.internals.push({ id: imp.id, names, result: r.rc !== 0 ? `import loop failed (rc ${r.rc}): ${r.out.slice(-200)}` : missing.length ? 'MISSING' : 'ok', missing, files: names.map((n) => found[n] ?? null) });
  }
  if (!toSrc.image) unverified.push('internals: no --to-image, so Rev4a\'s import loop did not run (release-diff.md has the static reading)');

  // ── Report ───────────────────────────────────────────────────
  const bad = {
    configKeys: facts.configKeys.filter((r) => /MISSING|NOT ACCEPTED/.test(r.result)),
    fields: facts.fields.filter((f) => f.status === 'lost'),
    cli: facts.cli.filter((c) => /GONE|NO PAGE/.test(c.docs?.result ?? '') || /NOT IN/.test(c.help?.result ?? '')),
    legacy: facts.legacy.filter((l) => l.newInTo !== false),
    ids: facts.ids.filter((i) => !i.found),
    internals: facts.internals.filter((i) => /MISSING|failed/.test(i.result)),
  };
  facts.findings = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.length]));
  const L = []; const out = (s = '') => L.push(s);
  const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
  out(`# What Rev4a depends on, against ${facts.to}`);
  out();
  out(`Findings: ${Object.entries(facts.findings).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  for (const u of unverified) out(`- **Unverified:** ${u}`);
  out();
  out('## C1 Config keys Rev4a writes or reads');
  out();
  out('| Id | Mode | Path | TO | FROM | Result |'); out('|---|---|---|---|---|---|');
  for (const r of [...facts.configKeys].sort((x, y) => (x.result === 'ok') - (y.result === 'ok'))) out(`| ${r.id} | ${r.mode} | ${code(r.path)} | ${r.to}${r.at && r.to === 'open' ? ` at ${code(r.at)}` : ''} | ${r.from ?? '–'} | ${r.result === 'ok' ? 'ok' : `**${r.result}**`}${r.valuesLost ? ` ${r.valuesLost.map(code).join(', ')}` : ''} |`);
  out();
  out('## C2 JSON fields Rev4a parses');
  out();
  if (facts.fields.length) {
    const by = (s) => facts.fields.filter((f) => f.status === s);
    out(`present ${by('present').length}, **lost ${by('lost').length}**, not comparable ${by('not-comparable').length}, not exercised ${by('absent').length}, item failed ${by('no-item').length}, optional and absent ${by('optional-absent').length}.`);
    out();
    for (const f of [...by('lost'), ...by('no-item'), ...by('absent'), ...by('not-comparable')]) out(`- ${f.status === 'lost' ? '**LOST**' : f.status} ${f.id} ${code(f.item)} ${code(f.path)}${f.needsSeed ? ` (needs ${f.needsSeed})` : ''}`);
  } else out('Not checked.');
  out();
  out('## C3 CLI commands and flags');
  out();
  for (const c of facts.cli) {
    const d = c.docs ? `docs ${c.docs.result}${c.docs.missing?.length ? ` (${c.docs.missing.join(' ')})` : ''}` : 'docs unverified';
    const h = c.help ? `; --help ${c.help.result}${c.help.missing?.length ? ` (${c.help.missing.join(' ')})` : ''}` : '';
    const loud = /GONE|NO PAGE|NOT IN/.test(`${d}${h}`);
    if (loud || c.docs?.result !== 'ok' || (c.help && c.help.result !== 'ok')) out(`- ${loud ? '**' : ''}${c.id} ${code(c.command)}: ${d}${h}${loud ? '**' : ''}`);
  }
  out(`- ${facts.cli.filter((c) => c.docs?.result === 'ok' && (!c.help || c.help.result === 'ok')).length} of ${facts.cli.length} commands: every subcommand and flag documented in TO${toSrc.image ? ' and listed by --help' : ''}.`);
  out('- "undocumented" means the page never mentioned it (in FROM either): not a regression, but nothing checks it.');
  out();
  out(`## C4 Config paths TO migrates or retires that Rev4a names (${facts.legacy.length} of ${facts.legacyPaths ?? '?'})`);
  out();
  out(facts.legacy.length ? facts.legacy.map((l) => `- ${l.newInTo === false ? '(already in FROM) ' : l.newInTo ? '**new in TO** ' : ''}${code(l.path)} [${l.src}${l.msg ? `: ${l.msg.slice(0, 120)}` : ''}] — Rev4a (${l.exact ? 'full path' : `only ${code(l.needle)}: check the parent`}): ${l.rev4a.map((x) => code(x.slice(0, 140))).join('; ')}`).join('\n') : (toPkg ? 'None.' : 'Not checked.'));
  out();
  out('## Ids and internals');
  out();
  for (const i of facts.ids) out(`- ${i.id} ${i.kind} ${code(i.name)}: ${i.found ? 'found in TO' : '**NOT FOUND in TO**'}`);
  for (const i of facts.internals) out(`- ${i.id} ${i.names.map(code).join(', ')}: ${i.result}${i.missing?.length ? ` (${i.missing.join(', ')})` : ''}`);

  writeReport(outMd, L.join('\n'), facts);
  return 0;
});
