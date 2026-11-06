#!/usr/bin/env node
// compare.mjs <snapshot dir A> <snapshot dir B> [--out <compare.md>] [--work <dir>] [--repo <rev4a checkout>] [--allow-incomplete]
//
// Compares two snapshot.mjs captures (usually the same agent before and after an update, or a
// control on the old release against a candidate on the new one) and writes compare.md (for
// people) and compare.json (facts for triage.mjs):
//   0. a Triage list: what to read first, at most about 15 lines;
//   1. items whose outcome changed, items failing in BOTH snapshots (never verified), and items
//      empty or failing on both sides (not exercised);
//   2. JSON paths removed, retyped or widened per item. A path Rev4a parses (references/deps.json
//      `fields`) is tagged with its inventory id and listed first; for other CLI/RPC/file items a
//      word search of the Rev4a code is shown, labelled as such. Rev4a's own `api.*` answers get no
//      lookup: their changes are in "Rev4a API answers that differ". Data-dependent differences
//      (a field null on one side, an array empty on one side) are counted as "not comparable";
//   3. facts that must hold across an update: cron jobs (user jobs and OpenClaw-owned ones apart),
//      database versions (an increase is one-way: rollback needs the backup), tables, plugins and
//      skills on the volume, memory in MB, restarts, OOM, disk and `.bak` files, files in
//      agents/*/agent, listening ports, cost per day, and the Rev4a API values users see (one that
//      differs and carries an error, or `reachable`/`resolvable: false`, in B is a blocker candidate);
//   4. new notable log lines, the doctor's boxes and the entrypoint lines of B.
// It judges nothing on its own: every line is something to read, explain or turn into a fix.
//
// Refuses (exit 2) a snapshot that is incomplete, failed its preflight (ok:false) or was taken by
// an older snapshot.mjs without one, unless --allow-incomplete; then every such fact is a warning
// at the top. Exit 1 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import {
  PORT_BLOCK, UsageError, Untrustworthy, apiProblem, checkFields, compareTriage, cronJobs, diffShapes, firstJson, gitGrep,
  jsonProblem, loadDeps, main, parseMemUsage, repoRoot, shapeMap, workDir, writeReport,
} from './lib.mjs';

const USAGE = `usage: compare.mjs <snapshot A> <snapshot B> [--out <compare.md>] [--work <dir>] [--repo <rev4a checkout>] [--allow-incomplete]

  --out <file.md>      report path; compare.json is written next to it (default <work>/compare.md)
  --allow-incomplete   compare snapshots that are incomplete, failed or of an older format (each is a warning)

Exit: 0 compared; 1 usage error; 2 a snapshot is not trustworthy (see the message).`;
const SPEC = { out: 'string', work: 'string', repo: 'string', 'allow-incomplete': 'boolean' };
const FORMAT_VERSION = 2;

/** A snapshot directory: index (normalised across format versions), raw texts, parsed JSON. */
function loadSnapshot(dir) {
  if (!fs.existsSync(path.join(dir, 'index.json'))) throw new UsageError(`${dir} has no index.json: not a snapshot directory`);
  let index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  // The first prototype wrote a bare array of items.
  if (Array.isArray(index)) index = { items: index };
  index.formatVersion ??= 1;
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  const cache = new Map();
  const json = (item) => {
    if (!cache.has(item)) { const t = read(`${item}.raw`); cache.set(item, t === null ? undefined : firstJson(t)); }
    return cache.get(item);
  };
  // Older indexes have no `ok`: derive it the same way snapshot.mjs does now.
  for (const it of index.items) {
    if (typeof it.ok === 'boolean') continue;
    const rcOk = it.rc === 0 || (it.rc >= 200 && it.rc < 300);
    const v = it.json ? json(it.name) : undefined;
    it.ok = rcOk && !jsonProblem(v);
    if (!it.ok) it.problem = rcOk ? jsonProblem(v) : `rc ${it.rc}`;
    if (v !== undefined && v !== null && typeof v === 'object') it.empty = Object.keys(v).length === 0;
  }
  const lines = (item) => (read(`${item}.raw`) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { dir, index, read, json, lines, byName: new Map(index.items.map((i) => [i.name, i])) };
}

/** Is a snapshot fit to compare? Returns the reasons it is not. */
function trustProblems(s) {
  const p = [];
  if (s.index.formatVersion < FORMAT_VERSION) p.push(`taken by an older snapshot.mjs (format ${s.index.formatVersion}): no preflight, no per-item ok`);
  if (s.index.complete !== true) p.push('incomplete (the snapshot was interrupted)');
  if (s.index.ok === false) p.push(`failed: ${(s.index.problems ?? []).join('; ') || 'see its index.md'}`);
  return p;
}

await main(USAGE, SPEC, async (args) => {
  const [dirA, dirB] = args._.map((d) => path.resolve(d));
  if (!dirA || !dirB || args._.length !== 2) throw new UsageError(`two snapshot directories are required\n\n${USAGE}`);
  const repo = repoRoot(args.repo);
  const deps = loadDeps();
  const A = loadSnapshot(dirA); const B = loadSnapshot(dirB);
  const outMd = args.out ? path.resolve(args.out) : path.join(workDir(args), 'compare.md');

  const warnings = [];
  for (const [n, s] of [['A', A], ['B', B]]) {
    const p = trustProblems(s);
    if (p.length && !args['allow-incomplete']) throw new Untrustworthy(`snapshot ${n} (${s.dir}) is ${p.join('; ')}. Take it again, or pass --allow-incomplete to compare anyway`);
    for (const x of p) warnings.push(`Snapshot ${n} is ${x}.`);
    for (const x of s.index.problems ?? []) if (s.index.ok !== false) warnings.push(`Snapshot ${n}: ${x}`);
    if (s.index.preflight?.settle && !s.index.preflight.settle.settled) warnings.push(`Snapshot ${n} was not settled (cpu ${s.index.preflight.settle.cpu}%, uptime ${s.index.preflight.settle.uptimeS}s): memory and timings are not idle values.`);
    if (s.index.seed && !s.index.seed.cronJob) warnings.push(`Snapshot ${n} has no seed cron job: the cron-runs items were skipped (run seed.mjs).`);
  }
  if (A.index.container && B.index.container && A.index.container !== B.index.container) {
    warnings.push(`A and B are different containers (${A.index.container} vs ${B.index.container}): jobs, files and data differ for that reason alone.`);
  }
  if (A.index.formatVersion !== B.index.formatVersion) warnings.push(`A and B were taken by different snapshot.mjs versions (${A.index.formatVersion} vs ${B.index.formatVersion}): renamed items show as "only in", and redaction may differ.`);

  const facts = {
    formatVersion: 1,
    a: { dir: dirA, label: A.index.label, container: A.index.container, takenAt: A.index.takenAt, version: (A.read('runtime.version.raw') || '').trim(), trust: trustProblems(A) },
    b: { dir: dirB, label: B.index.label, container: B.index.container, takenAt: B.index.takenAt, version: (B.read('runtime.version.raw') || '').trim(), trust: trustProblems(B) },
    warnings,
  };

  // ── 1. Outcomes ──────────────────────────────────────────────
  const names = [...new Set([...A.byName.keys(), ...B.byName.keys()])].sort();
  const onlyIn = { a: [], b: [] }; const changed = []; const failingBoth = []; const notExercised = [];
  for (const name of names) {
    const a = A.byName.get(name); const b = B.byName.get(name);
    if (!a || !b) { onlyIn[a ? 'a' : 'b'].push(name); continue; }
    if (!a.ok && !b.ok) (a.optional || b.optional ? notExercised : failingBoth).push({ name, a: a.problem ?? `rc ${a.rc}`, b: b.problem ?? `rc ${b.rc}` });
    else if (a.ok !== b.ok) changed.push({ name, a: a.ok ? 'ok' : (a.problem ?? `rc ${a.rc}`), b: b.ok ? 'ok' : (b.problem ?? `rc ${b.rc}`) });
    else if (a.empty && b.empty) notExercised.push({ name, a: 'empty', b: 'empty' });
  }
  Object.assign(facts, { itemsChanged: changed, itemsFailingBoth: failingBoth, onlyIn, notExercised });

  // ── 2. Shapes ────────────────────────────────────────────────
  // Recomputed from the raw output of the items both indexes list (never from *.shape files,
  // which a reused directory could hold from an earlier run).
  const shapesOf = (s) => new Map(s.index.items.filter((i) => i.ok && i.json).map((i) => [i.name, s.json(i.name)]).filter(([, v]) => v !== undefined).map(([n, v]) => [n, shapeMap(v)]));
  const shA = shapesOf(A); const shB = shapesOf(B);
  // deps.json fields: item → path → inventory ids.
  const inv = new Map();
  for (const f of deps.fields) for (const spec of f.paths) for (const p of spec.split('|')) {
    const k = `${f.item} ${p}`;
    inv.set(k, [...new Set([...(inv.get(k) ?? []), f.id])]);
  }
  const invOf = (item, p) => {
    const ids = new Set();
    for (const [k, v] of inv) {
      const [it, fp] = k.split(' ');
      // The path itself, or an ancestor of a parsed field (a removed parent removes the field).
      if (it === item && (p === fp || fp.startsWith(`${p}.`) || fp.startsWith(`${p}[]`))) v.forEach((x) => ids.add(x));
    }
    return [...ids].sort();
  };
  const grepCache = new Map();
  const wordUsers = (p) => {
    const key = p.split(/[.[\]]/).filter((x) => x && x !== '$' && x !== '<key>').pop() ?? '';
    if (!/^[A-Za-z_][\w-]*$/.test(key) || key.length < 3) return null;
    if (!grepCache.has(key)) grepCache.set(key, gitGrep(repo, key, { word: true, filesOnly: true }));
    return grepCache.get(key);
  };
  const shape = {};
  for (const name of names) {
    const a = shA.get(name); const b = shB.get(name);
    if (!a || !b) continue;
    const d = diffShapes(a, b);
    if (!d.removed.length && !d.retyped.length && !d.widened.length && !d.added.length && !d.notComparable.length) continue;
    const tag = (x) => {
      const ids = invOf(name, x.path);
      if (ids.length) return { ...x, inventory: ids };
      if (name.startsWith('api.')) return x;
      const users = wordUsers(x.path);
      return users === null ? x : { ...x, wordMatches: users.slice(0, 4), wordMatchCount: users.length };
    };
    shape[name] = { removed: d.removed.map(tag), retyped: d.retyped.map(tag), widened: d.widened.map(tag), added: d.added, notComparable: d.notComparable.length };
  }
  facts.shape = shape;
  const fieldCheck = checkFields(deps.fields, shB, shA);
  facts.fields = {
    lost: fieldCheck.filter((f) => f.status === 'lost'),
    absent: fieldCheck.filter((f) => f.status === 'absent'),
    noItem: fieldCheck.filter((f) => f.status === 'no-item'),
    present: fieldCheck.filter((f) => f.status === 'present').length,
  };

  // ── 3. Facts ─────────────────────────────────────────────────
  const jobsOf = (s) => cronJobs(s.json('cli.cron-list'));
  const jobLabel = (j) => `${j.name}${j.enabled === false ? ' (disabled)' : ''}`;
  const split = (s) => {
    const jobs = jobsOf(s);
    return { user: jobs.filter((j) => !j.declarationKey).map(jobLabel).sort(), owned: jobs.filter((j) => j.declarationKey).map((j) => `${jobLabel(j)} [${String(j.declarationKey).split(':')[0]}:]`).sort() };
  };
  const listDiff = (a, b) => ({ a: a.length, b: b.length, gone: a.filter((x) => !b.includes(x)), new: b.filter((x) => !a.includes(x)) });
  const ja = split(A); const jb = split(B);
  const cron = { user: listDiff(ja.user, jb.user), owned: listDiff(ja.owned, jb.owned), readA: A.byName.get('cli.cron-list')?.ok ?? false, readB: B.byName.get('cli.cron-list')?.ok ?? false };
  const dbsOf = (s) => {
    const v = s.json('file.db-versions');
    if (!v || jsonProblem(v)) return null;
    return Object.fromEntries(Object.entries(v).map(([f, x]) => [f.replace(/^\.\//, '').replace(/[0-9a-f-]{8,}/g, '<id>'), x]));
  };
  const da = dbsOf(A); const db = dbsOf(B);
  const dbVersions = [];
  for (const f of [...new Set([...Object.keys(da ?? {}), ...Object.keys(db ?? {})])].sort()) {
    const va = da?.[f]?.user_version; const vb = db?.[f]?.user_version;
    dbVersions.push({ file: f, a: va ?? null, b: vb ?? null, oneWay: typeof va === 'number' && typeof vb === 'number' && vb > va, gone: !!da?.[f] && !db?.[f] });
  }
  const tablesOf = (d) => [...new Set(Object.values(d ?? {}).flatMap((x) => x.tables ?? []))].sort();
  const memOf = (s) => {
    const st = s.json('runtime.stats'); const z = s.json('runtime.startupz'); const ins = s.json('runtime.inspect');
    const m = parseMemUsage(st?.mem);
    return { ...m, pct: m.usedMb && m.limitMb ? Math.round((100 * m.usedMb) / m.limitMb) : null, cpu: st?.cpu ?? null, uptimeS: z?.uptimeMs ? Math.round(z.uptimeMs / 1000) : null, restarts: ins?.restarts ?? null, oomKilled: ins?.oomKilled ?? null, image: ins?.image ?? null };
  };
  const bakOf = (s) => s.lines('file.bak-files').reduce((n, l) => n + (Number(l.split(' ')[0]) || 0), 0);
  const agentDirOf = (s) => s.lines('file.agent-dir').map((l) => l.split(/\s+/).pop()).filter((f) => f && !['.', '..'].includes(f) && !/^total$/.test(f) && !f.startsWith('/'));
  const portsOf = (s) => { const v = s.json('runtime.listeners'); return Array.isArray(v) ? v : null; };
  const dailyCost = (s) => Object.fromEntries((s.json('rpc.usage-cost')?.daily ?? []).map((d) => [d.date, d.totalCost]));
  const ca = dailyCost(A); const cb = dailyCost(B);
  const dayA = (A.index.takenAt ?? '').slice(0, 10);
  const costsChanged = Object.keys(ca).filter((d) => d < dayA && d in cb && Math.abs((ca[d] ?? 0) - (cb[d] ?? 0)) > 1e-9).map((d) => ({ date: d, a: ca[d], b: cb[d] }));
  const portsB = portsOf(B);
  Object.assign(facts, {
    cron, dbVersions,
    tables: listDiff(tablesOf(da), tablesOf(db)),
    plugins: listDiff(A.lines('file.volume-plugins'), B.lines('file.volume-plugins')),
    workspaceSkills: listDiff(A.lines('file.workspace-skills'), B.lines('file.workspace-skills')),
    volumeTree: listDiff(A.lines('file.volume-tree'), B.lines('file.volume-tree')),
    memory: { a: memOf(A), b: memOf(B) },
    volumeSize: { a: A.lines('file.volume-size'), b: B.lines('file.volume-size') },
    bakBytes: { a: bakOf(A), b: bakOf(B) },
    agentDir: { a: agentDirOf(A), b: agentDirOf(B), staleInB: agentDirOf(B).filter((f) => /^(models|auth-profiles)\.json$/.test(f)) },
    listeners: { a: portsOf(A), b: portsB, outsideBlockB: (portsB ?? []).filter((p) => p >= 1024 && (p < PORT_BLOCK[0] || p > PORT_BLOCK[1])) },
    costsChanged,
  });

  // Rev4a API values users see: shown side by side when they differ.
  const container = B.index.container ?? A.index.container;
  const pick = {
    'api.channels': (j) => j?.telegram ?? null,
    'api.pairing': (j) => j,
    'api.devices': (j) => j && { keys: Object.keys(j), pending: j.pending?.length, approved: j.approved?.length, error: j.error },
    'api.memory-limit': (j) => j && { limitMb: j.limitMb, swapMb: j.swapMb },
    'api.model': (j) => j && { primary: j.primary, fallbacks: j.fallbacks, resolvable: j.resolvable, reachable: j.reachable, error: j.error },
    'api.subscriptions': (j) => j?.agent && { connected: j.agent.connected, plan: j.agent.plan, usesSubscription: j.agent.usesSubscription, error: j.agent.error },
    'api.plugins': (j) => j && { count: j.plugins?.length, enabled: j.plugins?.filter((p) => p.enabled).length, error: j.error },
    // Fleet item (--fleet): this agent's workspace skills, plus the bundled list (read from whichever
    // agent answers first, so it is the TO release's only when no other release runs).
    'api.skills': (j) => j?.skills && { workspace: j.skills.filter((s) => s.type === 'workspace' && s.containerName === container).map((s) => s.name).sort(), bundled: j.skills.filter((s) => s.type === 'bundled').length, shared: j.skills.filter((s) => s.type === 'shared').length },
    'api.memory-context': (j) => j?.files?.map((f) => `${f.name}:${f.exists ? f.injected : 'missing'}`),
    'api.credentials-detect': (j) => j?.agents?.find((a) => a.container === container) ?? j?.error,
    'api.sessions-db': (j) => j?.sessions && { rows: j.sessions.filter((s) => s.container === container).length, gone: j.sessions.filter((s) => s.container === container && s.gone_at).length },
    'api.costs-agent': (j) => j && { available: j.available, error: j.error },
    // The proxy's metering of this agent: calls must go up after a chat turn, errors and calls
    // without a usage block must not, and nothing should land on 'unknown'.
    'api.costs-usage': (j) => j?.proxy && { agent: (j.proxy.byAgent ?? []).filter((l) => l.key === container).map((l) => l.metered && { calls: l.metered.calls, errors: l.metered.errors, noUsage: l.metered.noUsage })[0] ?? null, unknown: (j.proxy.byAgent ?? []).filter((l) => l.key === 'proxy:unknown').map((l) => l.metered?.calls)[0] ?? 0 },
    'api.update': (j) => j?.update && { status: j.update.status, error: j.update.error, verification: j.update.verification },
  };
  const apiDiffs = [];
  for (const [item, f] of Object.entries(pick)) {
    const vb = f(B.json(item)) ?? null;
    const a = JSON.stringify(f(A.json(item)) ?? null); const b = JSON.stringify(vb);
    // bProblem: B's answer carries an error or says the model is not reachable/resolvable.
    if (a !== b) apiDiffs.push({ item, a: a.slice(0, 400), b: b.slice(0, 400), bProblem: apiProblem(vb) });
  }
  facts.api = apiDiffs;
  facts.update = pick['api.update'](B.json('api.update')) ?? null;

  // ── 4. Logs ──────────────────────────────────────────────────
  const before = new Set(A.lines('log.notable'));
  facts.logs = {
    newNotable: B.lines('log.notable').filter((l) => !before.has(l)),
    doctorB: (B.read('log.doctor.raw') || '').split('\n'),
    entrypointB: B.lines('log.entrypoint'),
    readA: A.byName.get('log.notable')?.ok ?? null, readB: B.byName.get('log.notable')?.ok ?? null,
  };
  facts.logs.doctorB = facts.logs.doctorB.filter((l, i, arr) => l.trim() || (i > 0 && arr[i - 1].trim()));

  // ── Triage ───────────────────────────────────────────────────
  // One function for compare.mjs and triage.mjs (T13): the list is rebuilt from these facts there.
  const triage = compareTriage(facts);
  const ma = facts.memory.a; const mb = facts.memory.b;
  facts.triage = triage;

  // ── Markdown ─────────────────────────────────────────────────
  const L = [];
  const out = (s = '') => L.push(s);
  const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
  out('# OpenClaw snapshot comparison');
  out();
  out(`- A: ${code(dirA)} (${A.index.label ?? '?'}, ${A.index.container ?? '?'}, ${A.index.takenAt ?? '?'}) — ${code(facts.a.version)}`);
  out(`- B: ${code(dirB)} (${B.index.label ?? '?'}, ${B.index.container ?? '?'}, ${B.index.takenAt ?? '?'}) — ${code(facts.b.version)}`);
  for (const w of warnings) out(`- **Warning:** ${w}`);
  out();
  out('## Triage');
  out();
  out('Read these first. `blocker-candidate`: probably breaks Rev4a until explained; `read-first`: needs a decision; `unverified`: nothing was compared.');
  out();
  const order = { 'blocker-candidate': 0, 'read-first': 1, unverified: 2 };
  const sorted = [...triage].sort((x, y) => order[x.level] - order[y.level]);
  out(sorted.length ? sorted.slice(0, 15).map((t) => `- \`${t.level}\` ${t.text}`).join('\n') : 'Nothing: every compared item answered on both sides with the same shape and facts.');
  if (sorted.length > 15) out(`- … ${sorted.length - 15} more in compare.json \`triage\``);
  out();

  out('## 1. Item outcomes');
  out();
  out(changed.length ? changed.map((x) => `- ${code(x.name)}: ${x.a} → **${x.b}**`).join('\n') : 'No item changed outcome.');
  if (failingBoth.length) { out(); out('**Failing in both snapshots (not verified):**'); for (const x of failingBoth) out(`- ${code(x.name)}: A ${x.a.slice(0, 150)} — B ${x.b.slice(0, 150)}`); }
  for (const s of ['a', 'b']) if (onlyIn[s].length) { out(); out(`Only in ${s.toUpperCase()}: ${onlyIn[s].map(code).join(', ')}`); }
  if (notExercised.length) { out(); out(`Not exercised (empty, or optional and failing, on both sides): ${notExercised.map((x) => code(x.name)).join(', ')}`); }
  out();

  out('## 2. JSON shape changes');
  out();
  out('Inventory-tagged paths are parsed by Rev4a (references/deps.json). "word match" is a plain word search of the Rev4a code: confirm it before calling it a dependency.');
  out();
  const shapeLines = [];
  for (const [item, d] of Object.entries(shape)) {
    const rows = [];
    const label = (x) => (x.inventory ? ` — **Rev4a parses it (${x.inventory.join(', ')})**` : x.wordMatchCount ? ` — word match in ${x.wordMatches.join(', ')}${x.wordMatchCount > 4 ? ` (+${x.wordMatchCount - 4})` : ''}` : x.wordMatchCount === 0 ? ' — not in the Rev4a code' : '');
    const removedSorted = [...d.removed].sort((x, y) => (y.inventory ? 1 : 0) - (x.inventory ? 1 : 0));
    for (const x of d.retyped) rows.push({ inv: !!x.inventory, text: `- retyped ${x.from.join('|')} → ${x.to.join('|')}: ${code(x.path)}${label(x)}` });
    for (const x of removedSorted) rows.push({ inv: !!x.inventory, text: `- removed: ${code(x.path)}${x.paths > 1 ? ` (${x.paths} paths)` : ''}${label(x)}` });
    for (const x of d.widened) rows.push({ inv: !!x.inventory, text: `- widened ${x.from.join('|')} → ${x.to.join('|')}: ${code(x.path)}${label(x)}` });
    // The agent's config: every added path, since a new key there can change behaviour.
    if (d.added.length) rows.push({ inv: false, text: item === 'file.openclaw-json' ? d.added.map((x) => `- added: ${code(x.path)}`).join('\n') : `- added: ${d.added.length} subtree(s), e.g. ${d.added.slice(0, 5).map((x) => code(x.path)).join(', ')}` });
    if (d.notComparable) rows.push({ inv: false, text: `- not comparable (null or empty on one side): ${d.notComparable} path(s)` });
    shapeLines.push({ inv: rows.some((r) => r.inv), text: [`### ${item}`, ...rows.sort((x, y) => (y.inv ? 1 : 0) - (x.inv ? 1 : 0)).map((r) => r.text), ''].join('\n') });
  }
  out(shapeLines.length ? shapeLines.sort((x, y) => (y.inv ? 1 : 0) - (x.inv ? 1 : 0)).map((s) => s.text).join('\n') : 'None.\n');
  if (facts.fields.absent.length || facts.fields.noItem.length) {
    out('**Fields Rev4a parses that no snapshot holds** (not exercised; `needs` names the seed that would fill them):');
    for (const f of [...facts.fields.absent, ...facts.fields.noItem]) out(`- ${f.id} ${code(f.item)} ${code(f.path)}${f.status === 'no-item' ? ' (item failed or skipped in B)' : ''}${f.needsSeed ? ` — needs ${f.needsSeed}` : ''}`);
    out();
  }

  out('## 3. Facts');
  out();
  const ld = (title, d) => out(`- ${title}: ${d.a} → ${d.b}${d.gone.length ? `; **gone:** ${d.gone.map(code).join(', ')}` : ''}${d.new.length ? `; new: ${d.new.map(code).join(', ')}` : ''}`);
  if (!cron.readA || !cron.readB) out(`- **Cron list not read** in ${!cron.readA ? 'A' : ''}${!cron.readA && !cron.readB ? ' and ' : ''}${!cron.readB ? 'B' : ''}: the counts below mean nothing.`);
  ld('User cron jobs', cron.user);
  ld('OpenClaw-owned cron jobs (declarationKey prefix)', cron.owned);
  if (!da || !db) out(`- **Database versions not read** in ${!da ? 'A' : 'B'}.`);
  for (const d of dbVersions) out(`- ${code(d.file)} user_version ${d.a ?? '–'} → ${d.b ?? '–'}${d.oneWay ? ' — **one-way: rollback needs the backup**' : ''}${d.gone ? ' — **gone**' : ''}`);
  ld('Tables', facts.tables);
  ld('Plugins on the volume', facts.plugins);
  ld('Workspace skills', facts.workspaceSkills);
  ld('Volume tree (depth 3)', facts.volumeTree);
  const memLine = (m) => `${m.usedMb ?? '?'} MB of ${m.limitMb ?? '?'} MB (${m.pct ?? '?'}%), cpu ${m.cpu ?? '?'}, at uptime ${m.uptimeS ?? '?'}s`;
  out(`- Memory: A ${memLine(ma)} — B ${memLine(mb)}`);
  out(`- Restarts ${ma.restarts ?? '?'} → ${mb.restarts ?? '?'}; OOMKilled ${ma.oomKilled ?? '?'} → ${mb.oomKilled ?? '?'}; image ${code(ma.image)} → ${code(mb.image)}`);
  out(`- Volume size (KB): A ${code(facts.volumeSize.a.join(' | '))} — B ${code(facts.volumeSize.b.join(' | '))}; doctor .bak files: ${Math.round(facts.bakBytes.a / 1024)} → ${Math.round(facts.bakBytes.b / 1024)} KB`);
  out(`- agents/*/agent: A ${code(facts.agentDir.a.join(' '))} — B ${code(facts.agentDir.b.join(' '))}`);
  out(`- Listening ports: A ${code(JSON.stringify(facts.listeners.a))} — B ${code(JSON.stringify(facts.listeners.b))}`);
  out(`- Cost per day (usage.cost): ${costsChanged.length ? `**days before the update changed:** ${costsChanged.map((c) => `${c.date} ${c.a} → ${c.b}`).join(', ')}` : `${Object.keys(ca).length} → ${Object.keys(cb).length} days, earlier days unchanged`}`);
  out();
  out('### Rev4a API answers that differ');
  out();
  out(apiDiffs.length ? apiDiffs.map((x) => `- ${code(x.item)}\n  - A: ${code(x.a)}\n  - B: ${code(x.b)}`).join('\n') : 'None.');
  out();

  out('## 4. Logs of B');
  out();
  if (facts.logs.readB === false) out('**The log of B could not be read.**');
  out('### New notable lines');
  out();
  out(facts.logs.newNotable.length ? facts.logs.newNotable.slice(0, 60).map((l) => `- ${code(l.slice(0, 240))}`).join('\n') : 'None new.');
  out();
  out('### Doctor output (whole boxes, from the start of the container)');
  out();
  out(facts.logs.doctorB.length ? ['```', ...facts.logs.doctorB.slice(0, 200), '```'].join('\n') : 'None.');
  out();
  out('### Entrypoint lines');
  out();
  out(facts.logs.entrypointB.length ? facts.logs.entrypointB.slice(0, 40).map((l) => `- ${code(l.slice(0, 240))}`).join('\n') : 'None (or not captured by this snapshot version).');

  writeReport(outMd, L.join('\n'), facts);
  return 0;
});
