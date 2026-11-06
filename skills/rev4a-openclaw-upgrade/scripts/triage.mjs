#!/usr/bin/env node
// triage.mjs --work <dir> [--from <v>] [--to <v>] [--facts <manual.json>] [--repo <dir>]
//
// Decides, from the JSON sidecars of one run, whether a release may take the MINOR track or must
// escalate to the FULL one. Reads from --work: release-diff.json, schema-diff.json and
// rev4a-deps.json (the static inputs: all three are required), then compare.json (the live input;
// compare.mjs read the snapshots) and manual.json (facts a person measured, see below).
// Writes triage.md and triage.json: one row per precondition and trigger T1–T15, each `ok`,
// `full` (escalate), `check` (minor track plus one named check), `open` (a live trigger whose
// inputs do not exist yet) or `unverified` (its input exists but cannot answer: counts as full).
//
// Usable after the static steps alone: without compare.json, T12–T15 are `open` and do not
// escalate yet; once compare.json exists, every trigger must answer.
//
// manual.json (optional, written by hand; a missing key leaves its trigger unverified once live):
//   { "startupMs": { "from": 41000, "to": 52000 },  // `[entrypoint] Starting gateway` → ready, same host
//     "startupUnderLoadMs": { "from": 139144, "to": 175712 }, // optional paired busy-host sample
//     "createWaitMs": 120000,                        // Rev4a's create wait: 120000 native, 300000 emulated
//     "dmesgOom": false }                            // any "killed process" / oom line in the kernel log
//
// Every input must belong to this FROM → TO: an image tag in schema-diff.json or rev4a-deps.json
// must be `:FROM` / `:TO` (or its `-<sha>` pin), compare.json's B must run TO and its A FROM (or an
// older release: the control on the oldest version), else exit 2. A schema FILE whose name does not
// hold the version is only a warning: a file name proves nothing either way.
//
// Exit: 0 the minor track is allowed so far; 3 escalate to the full track (triage.md names the
// triggers); 2 a static input is missing or unreadable, or an input is for other versions; 1 usage error.
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, compareTriage, compareVersions, main, repoRoot, versionIn, versionLine, versionParts, writeReport,
} from './lib.mjs';

const USAGE = `usage: triage.mjs --work <dir> [--from <version>] [--to <version>] [--facts <manual.json>] [--out <triage.md>] [--repo <dir>]
                 [--versions-file <agent-versions.json>] [--history-file <history.md>]   (defaults: the repository's; overridden in tests)

Exit: 0 minor track allowed so far; 3 escalate to the full track; 2 a static input is missing or for other versions; 1 usage error.`;
const SPEC = { work: 'string', from: 'string', to: 'string', facts: 'string', out: 'string', repo: 'string', 'versions-file': 'string', 'history-file': 'string' };

/** Exit 2 with a reason: a required input is missing. */
class Incomplete extends Error {}

await main(USAGE, SPEC, async (args) => {
  if (!args.work) throw new UsageError(`--work is required\n\n${USAGE}`);
  const work = path.resolve(args.work);
  if (!fs.existsSync(work)) throw new UsageError(`${work} does not exist`);
  const repo = repoRoot(args.repo);
  const load = (name, required) => {
    const f = path.join(work, name);
    if (!fs.existsSync(f)) { if (required) throw new Incomplete(`${name} is missing in ${work}: run the step that writes it first`); return null; }
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Incomplete(`${name} is not valid JSON: ${e.message}`); }
  };
  let rd; let sd; let deps;
  try {
    rd = load('release-diff.json', true); sd = load('schema-diff.json', true); deps = load('rev4a-deps.json', true);
  } catch (e) {
    if (e instanceof Incomplete) { console.error(`INCOMPLETE: ${e.message}`); return 2; }
    throw e;
  }
  const cmp = load('compare.json', false);
  const manual = args.facts ? JSON.parse(fs.readFileSync(path.resolve(args.facts), 'utf8')) : load('manual.json', false) ?? {};
  const live = !!cmp;
  const from = args.from ?? rd.from; const to = args.to ?? rd.to;
  if (!versionParts(from) || !versionParts(to)) throw new UsageError('FROM and TO must be OpenClaw versions (from release-diff.json or --from/--to)');

  // ── The inputs belong to this FROM → TO ──────────────────────
  const warnings = []; const foreign = [];
  if (rd.from !== from || rd.to !== to) foreign.push(`release-diff.json compares ${rd.from} → ${rd.to}`);
  // An image reference (`name:tag`, no .json) must carry the version as its tag, or as the
  // published `<version>-<sha>` pin; a schema file saved by hand is only checked by its name.
  const source = (file, field, value, v) => {
    if (value === null || value === undefined || value === '') return;
    const s = String(value);
    if (!/\.json$/i.test(s) && /:[^/:]+$/.test(s)) {
      const tag = s.slice(s.lastIndexOf(':') + 1);
      const pin = tag.startsWith(`${v}-`) && /^[0-9a-f]{7,40}$/.test(tag.slice(v.length + 1));
      if (tag !== v && !pin) foreign.push(`${file} ${field} is ${s}, not an image tagged :${v}`);
    } else if (!path.basename(s).includes(v)) warnings.push(`${file} ${field} is the file ${path.basename(s)}: its name does not hold ${v}; check it is ${v}'s schema`);
  };
  source('schema-diff.json', 'from', sd.from, from); source('schema-diff.json', 'to', sd.to, to);
  source('rev4a-deps.json', 'from', deps.from, from); source('rev4a-deps.json', 'to', deps.to, to);
  if (cmp) {
    const va = versionIn(cmp.a?.version); const vb = versionIn(cmp.b?.version);
    if (!vb || compareVersions(vb, to) !== 0) foreign.push(`compare.json: snapshot B runs ${cmp.b?.version || 'no recorded version'}, not ${to}`);
    if (!va || compareVersions(va, from) > 0) foreign.push(`compare.json: snapshot A runs ${cmp.a?.version || 'no recorded version'}, not ${from}`);
    else if (compareVersions(va, from) < 0) warnings.push(`compare.json: snapshot A runs ${va}, older than FROM ${from} (the control on the oldest version)`);
  }
  if (foreign.length) {
    console.error(`INCOMPLETE: inputs in ${work} are not for ${from} → ${to}:\n  ${foreign.join('\n  ')}\nRerun the step that wrote each one for these versions.`);
    return 2;
  }

  const rows = [];
  const row = (id, title, result, proof) => rows.push({ id, title, result, proof: [proof].flat().filter(Boolean).map(String) });
  const list = (xs, n = 6) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` (+${xs.length - n})` : ''}`;

  // ── Preconditions of the minor track ─────────────────────────
  const versions = JSON.parse(fs.readFileSync(args['versions-file'] ? path.resolve(args['versions-file']) : path.join(repo, 'lib', 'agent-versions.json'), 'utf8')).supported ?? [];
  const fromEntry = versions.find((v) => v.version === from);
  row('P1', 'FROM is a shipped version (in lib/agent-versions.json with an imageRevision)', fromEntry?.imageRevision ? 'ok' : 'full',
    fromEntry ? `entry ${from}: imageRevision ${fromEntry.imageRevision ?? 'none'}` : `${from} is not in lib/agent-versions.json`);
  row('P2', 'TO is on the same release line as FROM', versionLine(from) === versionLine(to) && compareVersions(to, from) > 0 ? 'ok' : 'full',
    `${from} (line ${versionLine(from)}) → ${to} (line ${versionLine(to)})`);
  let history = '';
  try { history = fs.readFileSync(args['history-file'] ? path.resolve(args['history-file']) : new URL('../references/history.md', import.meta.url), 'utf8'); } catch { /* checked below */ }
  // A full evaluation of TO's line: a `## … → YYYY.M.D (…)` heading without `(minor`, whose entry
  // holds the line `**Verdict:** go` (references/history.md's header defines both).
  const lineRe = new RegExp(`→\\s*v?${versionLine(to)?.replace('.', '\\.')}\\.\\d`);
  const heading = (s) => s.split('\n')[0];
  const entries = history.split(/^(?=## )/m).filter((s) => s.startsWith('## ') && lineRe.test(heading(s)));
  const fullEntries = entries.filter((s) => !/\(minor\b/i.test(heading(s)));
  const goEntry = fullEntries.find((s) => /^\*\*Verdict:\*\* go\b/m.test(s));
  row('P3', 'The line has a full evaluation with the verdict go in references/history.md', goEntry ? 'ok' : 'full',
    goEntry ? `${heading(goEntry)}: **Verdict:** go`
      : fullEntries.length ? `${fullEntries.map(heading).join('; ')}: no "**Verdict:** go" line (that evaluation did not end in go)`
        : entries.length ? `only minor entries for ${versionLine(to)}.x: ${entries.map(heading).join('; ')}`
          : `no "## … → ${versionLine(to)}.x" heading in history.md`);
  if (!rd.distTags) row('P4', 'TO is the npm `latest`, or a -N hotfix of it', 'unverified', 'dist-tags not checked (release-diff.mjs ran --offline)');
  else {
    const latest = rd.distTags.latest;
    // A -N hotfix of latest's base release, never older than latest itself (10.10-2 when latest is 10.10-1).
    const okTag = latest === to || (versionParts(to)?.[3] > 0 && to.replace(/-\d+$/, '') === String(latest).replace(/-\d+$/, '') && compareVersions(to, latest) >= 0);
    row('P4', 'TO is the npm `latest`, or a -N hotfix of it', okTag ? 'ok' : 'full', `latest is ${latest}${!okTag && compareVersions(to, latest) < 0 ? `: ${to} is older` : ''}`);
  }

  // ── Static triggers ──────────────────────────────────────────
  const sv = (rd.schemaVersions ?? []).filter((s) => s.changed);
  row('T1', 'A *SCHEMA_VERSION constant changed', sv.length ? 'full' : 'ok', sv.map((s) => `${s.name} ${s.from?.join('/') ?? '–'} → ${s.to?.join('/') ?? '–'}`));
  const retNew = (rd.constants?.new ?? []).filter((c) => /^RETIRED_/.test(c.name));
  const retChanged = (rd.constants?.changed ?? []).filter((c) => /^(RETIRED|SYSTEM_OWNED)_/.test(c.name));
  row('T2', 'A RETIRED_* declaration is new, or a RETIRED_/SYSTEM_OWNED_ value changed', retNew.length || retChanged.length ? 'full' : 'ok',
    [...retNew.map((c) => `new ${c.name}`), ...retChanged.map((c) => `changed ${c.name}`)]);
  const nodeChanged = rd.engines?.from !== rd.engines?.to || rd.floors?.from !== rd.floors?.to;
  row('T3', 'engines.node or the Node security floors changed', nodeChanged ? 'full' : 'ok', `engines ${rd.engines?.from} → ${rd.engines?.to}; floors ${rd.floors?.from === rd.floors?.to ? 'unchanged' : 'changed'}`);
  const removedBundles = [...(rd.bundledSkills?.removed ?? []).map((s) => `skill ${s}`), ...(rd.bundledPlugins?.removed ?? []).map((p) => `plugin ${p}`)];
  // The hook ids, skill names and plugin ids Rev4a names (rev4a-deps `ids`), looked up in TO.
  const idsMissing = (deps.ids ?? []).filter((i) => !i.found).map((i) => `${i.id} ${i.kind} ${i.name} not found in TO`);
  const idsUnchecked = (deps.unverified ?? []).some((u) => /^ids:/.test(u));
  row('T4', 'A bundled skill or plugin was removed, or a hook, skill or plugin id Rev4a names is not in TO',
    removedBundles.length || idsMissing.length ? 'full' : idsUnchecked ? 'unverified' : 'ok',
    removedBundles.length || idsMissing.length ? [...removedBundles, ...idsMissing] : idsUnchecked ? 'ids not checked: rev4a-deps.mjs had no TO package' : `${(deps.ids ?? []).length} ids found in TO`);
  const pfGone = rd.paramFields?.gone ?? []; const pfDep = (rd.paramFields?.changed ?? []).filter((c) => c.inventory?.length);
  row('T5', 'A documented config key is gone, or a key Rev4a uses changed type/default', pfGone.length || pfDep.length ? 'full' : 'ok',
    [...pfGone.map((g) => `gone ${g.key}`), ...pfDep.map((c) => `changed ${c.key} (${c.inventory.join(',')})`)]);
  const lost = (sd.changed ?? []).filter((c) => c.typesLost?.length || c.optionsLost?.length);
  const depPaths = new Set((deps.configKeys ?? []).map((k) => k.at).filter(Boolean));
  const depDefaults = (sd.changed ?? []).filter((c) => 'defaultTo' in c && depPaths.has(c.path));
  const inputChange = (sd.changed ?? []).filter((c) => /^models\.providers\.<key>\.models\[\]\.input/.test(c.path));
  const depBad = (deps.configKeys ?? []).filter((k) => /^MISSING$|NOT ACCEPTED/.test(k.result));
  // Only a path new in TO: one FROM already migrated is old news (`newInTo` false). An older
  // rev4a-deps.json, or one without FROM's package, has no answer (undefined/null): it escalates.
  const legacyExact = (deps.legacy ?? []).filter((l) => l.exact && l.newInTo !== false);
  const t6 = [...(sd.removed ?? []).map((p) => `removed ${p}`), ...lost.map((c) => `${c.path}: ${[...c.typesLost, ...c.optionsLost].join(', ')} lost`),
    ...depDefaults.map((c) => `default of ${c.path} changed`), ...inputChange.map((c) => `${c.path} changed`),
    ...depBad.map((k) => `${k.id} ${k.path}: ${k.result}`), ...legacyExact.map((l) => `TO migrates or retires ${l.path}, which Rev4a names${l.newInTo ? ' (new in TO)' : " (FROM's rules not compared)"}`)];
  // A key missing from TO with no FROM schema to compare against is not proven either way.
  const depUnverified = (deps.configKeys ?? []).filter((k) => /unverified/.test(k.result ?? ''));
  row('T6', 'Schema: a path removed, a type or option lost, a Rev4a key changed, missing or migrated',
    t6.length ? 'full' : depUnverified.length ? 'unverified' : 'ok',
    [...t6, ...depUnverified.map((k) => `${k.id} ${k.path}: ${k.result} (rerun rev4a-deps with --from-image)`)]);
  const cliBad = [...(rd.cliRev4a ?? []).filter((c) => c.flagsGoneUsedByRev4a?.length || (c.pageFrom && !c.page)).map((c) => `${c.command}: ${c.page ? c.flagsGoneUsedByRev4a.join(' ') : 'no page'}`),
    ...(deps.cli ?? []).filter((c) => /GONE|NO PAGE/.test(c.docs?.result ?? '') || /NOT IN/.test(c.help?.result ?? '')).map((c) => `${c.command}: ${c.docs?.result}${c.help ? ` / --help ${c.help.result}` : ''}`)];
  const cliUnchecked = !(deps.cli ?? []).some((c) => c.docs);
  row('T7', 'A CLI page, subcommand or flag Rev4a runs is gone', cliBad.length ? 'full' : cliUnchecked ? 'unverified' : 'ok', cliBad.length ? cliBad : cliUnchecked ? 'rev4a-deps.mjs had no TO package' : `${deps.cli.length} commands checked`);
  const soon = Date.now() + 90 * 864e5;
  const t8 = [...(rd.internals ?? []).filter((i) => !i.found || !i.exported || i.deprecationNew || (/\d{4}-\d\d-\d\d/.test(i.deprecated ?? '') && Date.parse(i.deprecated.match(/\d{4}-\d\d-\d\d/)[0]) < soon))
    .map((i) => `${i.name}: ${!i.found ? 'not found' : !i.exported ? 'not exported' : i.deprecated}`),
  ...(deps.internals ?? []).filter((i) => /MISSING|failed/.test(i.result)).map((i) => `${i.names.join(', ')}: ${i.result}`)];
  // Rev4a's import loop not run (no --to-image): the static reading alone does not prove the import.
  const t8Unverified = (deps.internals ?? []).filter((i) => /unverified/.test(i.result ?? '')).map((i) => `${i.names.join(', ')}: ${i.result} (rerun rev4a-deps with --to-image)`);
  row('T8', 'An internal Rev4a imports is missing, unexported, newly deprecated or near its removal date', t8.length ? 'full' : t8Unverified.length ? 'unverified' : 'ok', [...t8, ...t8Unverified]);
  const beh = (rd.behaviour ?? []).filter((b) => b.inventory?.length);
  row('T9', 'A new doc line about a retirement, removal, rename or default in an inventory area', beh.length ? 'full' : 'ok', beh.slice(0, 8).map((b) => `${b.inventory.join(',')} ${b.file}: ${b.line.slice(0, 120)}`));
  if (!rd.notes?.fetched) row('T10', 'A release body says breaking/migration/removed/deprecated about an inventory area', 'unverified', `release notes ${rd.notes?.reason ?? 'not fetched'}`);
  else row('T10', 'A release body says breaking/migration/removed/deprecated about an inventory area', rd.notes.hits.length ? 'full' : 'ok', rd.notes.hits.length ? rd.notes.hits.slice(0, 8).map((h) => `${h.release} ${h.inventory.join(',')}: ${h.line.slice(0, 120)}`) : `${rd.notes.bodies.length} bodies read`);
  if (rd.codex?.changed === null || rd.codex?.changed === undefined) row('T11', '@openclaw/codex changed its openclaw peer or @openai/codex', 'unverified', `codex ${rd.codex?.from?.notFetched ?? rd.codex?.to?.notFetched ?? 'not compared'}`);
  else row('T11', '@openclaw/codex changed its openclaw peer or @openai/codex', rd.codex.changed ? 'check' : 'ok',
    `${rd.codex.from.version} (${rd.codex.from.peer}, ${rd.codex.from.codex}) → ${rd.codex.to.version} (${rd.codex.to.peer}, ${rd.codex.to.codex})${rd.codex.changed ? ': run the Subscription check with the owner\'s Connect' : ''}`);

  // ── Live triggers ────────────────────────────────────────────
  const openOr = (id, title, fn) => { if (!live) row(id, title, 'open', 'no compare.json yet'); else fn(); };
  openOr('T12', 'The real (migrated) config does not validate on TO', () => {
    const v = sd.config?.validate;
    if (!v?.ran) row('T12', 'The real (migrated) config does not validate on TO', 'unverified', 'schema-diff.mjs did not validate a config (--config with --to-image)');
    else row('T12', 'The real (migrated) config does not validate on TO', v.judgedIssues || sd.config.unknownInTo?.length ? 'full' : 'ok', `rc ${v.rc}, ${v.judgedIssues} issue(s) not on redacted values, ${sd.config.unknownInTo?.length ?? 0} path(s) unknown to TO`);
  });
  const T13 = 'After the update: a blocker candidate in compare.json, failed status, gone state, a changed DB version, new log lines';
  openOr('T13', T13, () => {
    const p = [];
    if (cmp.a?.trust?.length || cmp.b?.trust?.length) p.push(`a snapshot is not trustworthy: ${[...(cmp.a?.trust ?? []), ...(cmp.b?.trust ?? [])].join('; ')}`);
    if (!cmp.update) p.push('no update status in the after-snapshot');
    else if (cmp.update.status !== 'done') p.push(`update ${cmp.update.status}`);
    // compare.mjs's own triage list, rebuilt from the facts by the same function (lib.mjs
    // compareTriage): every blocker candidate escalates, every unverified entry is unverified.
    const triage = compareTriage(cmp);
    for (const x of triage.filter((y) => y.level === 'blocker-candidate')) p.push(x.text.replace(/`/g, ''));
    // Read-first entries that are still changes to explain before a minor.
    if (cmp.cron?.owned?.gone?.length) p.push(`OpenClaw-owned cron jobs gone: ${cmp.cron.owned.gone.join(', ')}`);
    if (cmp.tables?.gone?.length) p.push(`tables gone: ${list(cmp.tables.gone)}`);
    if (cmp.plugins?.gone?.length) p.push(`volume plugins changed: ${cmp.plugins.gone.join(', ')}`);
    for (const d of cmp.dbVersions ?? []) if (d.oneWay || d.gone || (d.a !== d.b)) p.push(`${d.file} user_version ${d.a} → ${d.b}`);
    if (cmp.logs?.newNotable?.length) p.push(`${cmp.logs.newNotable.length} new notable log line(s)`);
    const unv = triage.filter((y) => y.level === 'unverified').map((x) => `unverified: ${x.text.replace(/`/g, '')}`);
    row('T13', T13, p.length ? 'full' : unv.length ? 'unverified' : 'ok', p.length || unv.length ? [...p, ...unv] : 'update done, compare.md clean');
  });
  // Keep the historical 2 GiB warning baseline as a conservative escalation test,
  // independent of later target-specific admission floors and removed UI constants.
  const comfortable = 2048;
  openOr('T14', `Idle memory on TO > 115 % of FROM, > 70 % of ${comfortable} MB, or an OOM`, () => {
    const a = cmp.memory?.a; const b = cmp.memory?.b; const p = [];
    if (!a?.usedMb || !b?.usedMb) { row('T14', `Idle memory on TO > 115 % of FROM, > 70 % of ${comfortable} MB, or an OOM`, 'unverified', 'memory not read in a snapshot'); return; }
    if (b.usedMb > a.usedMb * 1.15) p.push(`${a.usedMb} → ${b.usedMb} MB`);
    if (b.usedMb > comfortable * 0.7) p.push(`${b.usedMb} MB > 70 % of historical warning baseline ${comfortable} MB`);
    if (b.oomKilled || manual.dmesgOom === true) p.push('OOM');
    const settled = !(cmp.warnings ?? []).some((w) => /not settled/.test(w));
    if (p.length) row('T14', `Idle memory on TO > 115 % of FROM, > 70 % of ${comfortable} MB, or an OOM`, 'full', p);
    else if (manual.dmesgOom === undefined || !settled) row('T14', `Idle memory on TO > 115 % of FROM, > 70 % of ${comfortable} MB, or an OOM`, 'unverified', [`${a.usedMb} → ${b.usedMb} MB`, manual.dmesgOom === undefined ? 'dmesg not recorded (manual.json dmesgOom)' : 'a snapshot was not settled']);
    else row('T14', `Idle memory on TO > 115 % of FROM, > 70 % of ${comfortable} MB, or an OOM`, 'ok', `${a.usedMb} → ${b.usedMb} MB, no OOM`);
  });
  openOr('T15', 'Startup on TO > 120 % of FROM, or > 50 % of the create wait', () => {
    const wait = manual.createWaitMs ?? 120_000;
    const pairs = [['idle', manual.startupMs]];
    if (Object.hasOwn(manual, 'startupUnderLoadMs')) pairs.push(['under load', manual.startupUnderLoadMs]);
    let bad = false; let missing = false; const proof = [];
    for (const [condition, s] of pairs) {
      if (![s?.from, s?.to].every(n => Number.isFinite(n) && n > 0)) {
        missing = true; proof.push(`${condition}: startup not measured as a valid FROM/TO pair`); continue;
      }
      bad ||= s.to > s.from * 1.2 || s.to > wait * 0.5;
      proof.push(`${condition}: ${s.from} → ${s.to} ms (wait ${wait} ms)`);
    }
    row('T15', 'Startup on TO > 120 % of FROM, or > 50 % of the create wait', bad ? 'full' : missing ? 'unverified' : 'ok', proof);
  });

  // ── Verdict ──────────────────────────────────────────────────
  const escalate = rows.filter((r) => r.result === 'full' || r.result === 'unverified');
  const open = rows.filter((r) => r.result === 'open');
  const checks = rows.filter((r) => r.result === 'check');
  const verdict = escalate.length ? 'full' : open.length ? 'minor-so-far' : 'minor';
  const facts = { from, to, live, verdict, escalate: escalate.map((r) => r.id), open: open.map((r) => r.id), checks: checks.map((r) => r.id), warnings, rows };
  const L = [`# Track triage: OpenClaw ${from} → ${to}`, '',
    `**Verdict: ${verdict === 'full' ? `FULL track (escalated by ${facts.escalate.join(', ')})` : verdict === 'minor-so-far' ? 'minor track allowed so far' : 'minor track'}**`,
    ...(open.length ? [`- Still open (live inputs not there yet): ${facts.open.join(', ')}. Run triage again after compare.mjs.`] : []),
    ...(checks.length ? [`- Extra checks on the minor track: ${facts.checks.join(', ')}.`] : []),
    ...warnings.map((w) => `- **Warning:** ${w}`),
    '- `unverified` counts as `full`: a trigger that cannot be checked escalates.', '',
    '| # | Trigger | Result | Proof |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.title} | ${r.result === 'ok' ? 'ok' : `**${r.result}**`} | ${r.proof.slice(0, 8).join('; ').replace(/\|/g, '/').slice(0, 900) || '–'} |`)];
  writeReport(args.out ? path.resolve(args.out) : path.join(work, 'triage.md'), L.join('\n'), facts);
  return verdict === 'full' ? 3 : 0;
});
