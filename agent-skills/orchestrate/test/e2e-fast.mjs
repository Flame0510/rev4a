// End to end for the fast gate: card specs + critical specs, risky paths and closure cards in full, one rerun of
// failed specs (flaky), and the cards merged since the last whole-suite pass. node test/e2e-fast.mjs [dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessInputKey, reusablePass, runHarness, shq, updateSuiteMarker } from '../scripts/lib/harness.mjs';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fast-'));
fs.rmSync(base, { recursive: true, force: true });
const projectDir = path.join(base, 'p');
fs.mkdirSync(projectDir, { recursive: true });
const REPO = fs.realpathSync(projectDir);
const FLAKY = path.join(base, 'flaky-once');
const ARGS = path.join(base, 'harness-args.log');

let n = 0;
let mockNodeVersion = null;
let orchPrelude = null;
const orch = (args, code = 0) => {
  const mock = mockNodeVersion ? ['--import', `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, 'version', { value: ${JSON.stringify(mockNodeVersion)} });`)}`] : [];
  const r = spawnSync(process.execPath, [...mock, ...(orchPrelude ? ['--import', `data:text/javascript,${encodeURIComponent(orchPrelude)}`] : []), ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base } });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const lastArgs = () => fs.readFileSync(ARGS, 'utf8').trim().split('\n').at(-1);

const card = (id, title, owned, extra = '') => `---
id: ${id}
title: ${title}
status: To Do
dependencies: []
modified_files:
${owned.map((o) => `  - ${o}`).join('\n')}
${extra}priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
${title}.
<!-- SECTION:DESCRIPTION:END -->
`;

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node -e 0' } }));
write('.gitignore', 'test-results/\n');
// Stands in for Playwright: logs its arguments; a full run fails once while FLAKY exists, naming a spec.
write('scripts/e2e.mjs', `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ARGS)}, (args.join(' ') || '<all>') + '\\n');
if (!args.length && fs.existsSync(${JSON.stringify(FLAKY)})) { fs.rmSync(${JSON.stringify(FLAKY)});
  console.log('  1 failed\\n    [chromium] › tests/e2e/02-orders.spec.mjs:3:1 › orders'); process.exit(1); }
if (fs.existsSync('app/broken')) { console.log('    [chromium] › tests/e2e/01-menu.spec.mjs:2:1 › menu'); process.exit(1); }
console.log('ok ' + (args.length || 'all'));
`);
for (const s of ['01-menu', '02-orders', '07-kitchen']) write(`tests/e2e/${s}.spec.mjs`, '// spec\n');
write('app/menu.mjs', 'export const m = 1;\n'); write('db/schema.sql', '-- schema\n'); write('docs/x.md', '# x\n');
write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
write('backlog/tasks/sb-10 - Feature.md', card('SB-10', 'Feature closure', ['docs/x.md', 'app/broken']));
write('backlog/tasks/sb-10.1 - Menu.md', card('SB-10.1', 'Menu change', ['app/menu.mjs', 'tests/e2e/01-menu.spec.mjs'], 'parent_task_id: SB-10\n'));
write('backlog/tasks/sb-10.2 - Schema.md', card('SB-10.2', 'Schema change', ['db/**'], 'parent_task_id: SB-10\n'));
write('backlog/tasks/sb-10.3 - Copy.md', card('SB-10.3', 'Copy without spec', ['app/copy.mjs'], 'parent_task_id: SB-10\n'));
g('add', '-A'); g('commit', '-q', '-m', 'p');
write('.orchestrate/config.json', JSON.stringify({
  confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'],
  harnesses: [{ name: 'e2e', command: 'node scripts/e2e.mjs', paths: ['app/**', 'db/**', 'tests/e2e/**'], when: 'gate', timeoutSec: 60, fast: { critical: ['tests/e2e/02-orders.spec.mjs'] } }],
  risk: { paths: ['db/**'] }, tests: { rule: 'off' },
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'] },
  roles: { worker: 'w', checker: 'c' },
}));
const W = (id) => path.resolve(REPO, `../.worktrees/orch-${id}`);
const runCard = (id, change, { checker = true, gateCode = 0 } = {}) => {
  orch(['start', id, '--force']);
  change(W(id));
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n');
  orch(['record', id, 'worker']);
  const o = orch(['gate', id], gateCode);
  if (checker && gateCode === 0) {
    write(ckr(id), 'EXECUTED: x -> ok\nVERDICT: PASS\n');
    orch(['record', id, 'checker']); orch(['finish', id]);
  }
  return o;
};

// 1. A normal card: its own spec + the critical one, never the whole suite.
let o = runCard('SB-10.1', (wt) => write('app/menu.mjs', 'export const m = 2;\n', wt));
has(o, /PASS {2}harness e2e \(fast\): node scripts\/e2e\.mjs 'tests\/e2e\/01-menu\.spec\.mjs' 'tests\/e2e\/02-orders\.spec\.mjs'/, 'fast gate: card spec + critical');
assert.equal(lastArgs(), 'tests/e2e/01-menu.spec.mjs tests/e2e/02-orders.spec.mjs'); n++;
const brief = fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-10.1/prompts/worker-r0.md'), 'utf8');
has(brief, /the gate runs your spec files plus the critical ones \(tests\/e2e\/02-orders\.spec\.mjs\), and the whole suite only for a closure card or when you change db\/\*\*/, 'worker brief explains the fast gate');
const chk = fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-10.1/prompts/checker-r0-a.md'), 'utf8');
has(chk, /`node scripts\/e2e\.mjs tests\/e2e\/01-menu\.spec\.mjs tests\/e2e\/02-orders\.spec\.mjs` \(fast gate\)/, 'checker brief names what the gate ran');

// 2. A card without its own spec: only the critical spec.
o = runCard('SB-10.3', (wt) => write('app/copy.mjs', 'export const c = 1;\n', wt));
has(o, /harness e2e \(fast\): node scripts\/e2e\.mjs 'tests\/e2e\/02-orders\.spec\.mjs'/, 'no own spec: critical only');

// 3. A risky card: the whole suite, which fails once (flaky) and passes on the rerun of the failed spec.
fs.writeFileSync(FLAKY, '1');
o = runCard('SB-10.2', (wt) => write('db/schema.sql', '-- schema v2\n', wt));
has(o, /PASS {2}harness e2e \(full: risky paths: db\/schema\.sql\): node scripts\/e2e\.mjs \(/, 'risky path: whole suite');
has(o, /WARN {2}flaky: tests\/e2e\/02-orders\.spec\.mjs failed in the full run and passed on a rerun/, 'flaky spec reported, not a failure');
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/_suite.json'), 'utf8'), /"card": "SB-10\.2"/, 'last whole-suite pass recorded');

// 4. Another normal card merged after that pass, then a closure card whose whole suite fails for real.
write('backlog/tasks/sb-11 - Other.md', card('SB-11', 'Other', ['app/other.mjs'])); g('add', '-A'); g('commit', '-q', '-m', 'SB-11');
runCard('SB-11', (wt) => write('app/other.mjs', 'export const o = 1;\n', wt));
o = runCard('SB-10', (wt) => { write('docs/x.md', '# x closed\n', wt); write('app/broken', 'x', wt); }, { gateCode: 2 });
has(o, /harness e2e \(full: closure card\): node scripts\/e2e\.mjs -> exit 1/, 'closure card: whole suite, even for a docs change');
has(o, /INFO {2}last whole-suite pass: SB-10\.2 \([^)]+\); cards merged into develop since: SB-11/, 'names the cards merged since the last green run');
assert.equal(lastArgs(), 'tests/e2e/01-menu.spec.mjs'); n++; // the failed spec was rerun alone, and failed again

// 5. The base moved after the gate: the merge repeats the gate's harness only when something that can change a
//    result moved. The in-repo tracker and merge.inertPaths cannot; application code can. Project checks always run.
const cfgFile = path.join(REPO, '.orchestrate/config.json');
const cfgJson = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfgJson.merge.inertPaths = ['docs/notes/**']; fs.writeFileSync(cfgFile, JSON.stringify(cfgJson));
const runs = () => fs.readFileSync(ARGS, 'utf8').trim().split('\n').length;
const moveCard = (id, file, move) => {
  write(`backlog/tasks/${id.toLowerCase()} - Move.md`, card(id, 'Move', [file])); g('add', '-A'); g('commit', '-q', '-m', id);
  orch(['start', id]);
  write(file, `export const v = '${id}';\n`, W(id));
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n'); orch(['record', id, 'worker']);
  orch(['gate', id]);
  write(ckr(id), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', id, 'checker']);
  move(); g('add', '-A'); g('commit', '-q', '-m', `develop moved under ${id}`);
  const before = runs();
  const out = orch(['finish', id]);
  return { out, reran: runs() - before };
};
let mv = moveCard('SB-12', 'app/twelve.mjs', () => write('backlog/tasks/sb-12 - Move.md', card('SB-12', 'Move', ['app/twelve.mjs']).replace('Move.', 'Move, edited on develop.')));
has(mv.out, /develop moved only in \d+ file\(s\) under [^:]*backlog\/\*\*: the gate's harnesses were not repeated \(project checks ran\)/, 'tracker-only move: noted');
assert.equal(mv.reran, 0, 'tracker-only move: harness not repeated'); n++;
mv = moveCard('SB-13', 'app/thirteen.mjs', () => write('docs/notes/x.md', '# a note\n'));
assert.equal(mv.reran, 0, 'inertPaths move: harness not repeated'); n++;
has(mv.out, /moved only in \d+ file\(s\) under [^:]*docs\/notes\/\*\*/, 'inertPaths named');
mv = moveCard('SB-14', 'app/fourteen.mjs', () => write('app/menu.mjs', 'export const m = 99;\n'));
assert.equal(mv.reran, 1, 'application move: harness repeated'); n++;
assert.ok(!/moved only in/.test(mv.out), 'no inert note'); n++;
mv = moveCard('SB-15', 'app/fifteen.mjs', () => { const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.limits = { ...(c.limits ?? {}), checkTimeoutSec: 901 }; fs.writeFileSync(cfgFile, JSON.stringify(c)); });
assert.equal(mv.reran, 1, 'a config change is a test input: harness repeated'); n++;

// 6. Whole-suite reuse is opt-in, and closure cards give us full runs despite changing only documentation.
const state = id => JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8'));
const markerFile = path.join(REPO, '.orchestrate/runs/_suite-e2e.json');
const marker = () => JSON.parse(fs.readFileSync(markerFile, 'utf8'));
const saveMarker = m => fs.writeFileSync(markerFile, JSON.stringify(m));
const reuseCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
reuseCfg.checks = ['node -e 0'];
reuseCfg.links = ['.env.local', 'node_modules'];
reuseCfg.harnesses[0].paths = ['app/**', 'tests/e2e/**', 'scripts/e2e.mjs'];
const saveCfg = () => fs.writeFileSync(cfgFile, JSON.stringify(reuseCfg));
fs.appendFileSync(path.join(REPO, '.git/info/exclude'), '\n/.env.local\n/node_modules\n');
write('.env.local', 'LOCAL_TEST_VALUE=initial\n');
fs.mkdirSync(path.join(REPO, 'node_modules'), { recursive: true });
for (const i of [...Array.from({ length: 28 }, (_, i) => i + 30), ...Array.from({ length: 19 }, (_, i) => i + 61)]) {
  const id = `SB-${i}`;
  write(`backlog/tasks/${id.toLowerCase()} - Reuse.md`, card(id, 'Reuse closure', ['docs/x.md', 'app/**', 'package-lock.json']));
  write(`backlog/tasks/${id.toLowerCase()}.1 - Child.md`, card(`${id}.1`, 'Child', ['docs/child.md'], `parent_task_id: ${id}\n`));
}
// A normal card exercises fast mode independently from closure selection.
write('backlog/tasks/sb-60 - Fast.md', card('SB-60', 'Fast', ['app/menu.mjs']));
saveCfg(); g('add', '-A'); g('commit', '-q', '-m', 'reuse fixtures');
const closureGate = (id, change = () => {}) => runCard(id, wt => {
  write('docs/x.md', `# closure ${id}\n`, wt); change(wt);
}, { checker: false });
const expectRun = (id, change, count = 1) => {
  const before = runs(); const output = closureGate(id, change);
  assert.equal(runs() - before, count, `${id}: full harness execution count`); n++;
  assert.equal(state(id).gate.harnessRuns[0].mode, 'full'); n++;
  assert.ok(!output.includes('REUSED from')); n++;
  return output;
};
expectRun('SB-30'); expectRun('SB-31');
console.log('reuse: default off runs the whole suite for both closure cards');

reuseCfg.harnesses[0].reuse = true; saveCfg();
has(orch(['config']), /reuse: on \(max 72 h\)/, 'config displays default reuse age');
for (const value of ['0', '"yes"', '{}', '{"maxAgeHours":0}', '{"maxAgeHours":-1}', '{"maxAgeHours":"24"}', '{"maxAgeHours":24,"extra":true}']) {
  orch(['config', '--set', `harnesses.0.reuse=${value}`], 1);
}
orch(['config', '--set', 'harnesses.0.when=merge'], 1);
// Enabling reuse on an older marker still requires a real pass first.
const old = marker(); delete old.passes; saveMarker(old);
expectRun('SB-32');
assert.equal(marker().passes.length, 1); n++;
assert.equal(marker().passes[0].tree, state('SB-32').gate.tree); n++;
assert.match(marker().passes[0].key, /^[a-f0-9]{64}$/); n++;
console.log('reuse: an older marker without passes runs normally, then gains a clean hashed pass');
const markerBefore = fs.readFileSync(markerFile, 'utf8');
const legacyBefore = fs.readFileSync(path.join(REPO, '.orchestrate/runs/_suite.json'), 'utf8');
const beforeReuse = runs(); o = closureGate('SB-33');
assert.equal(runs(), beforeReuse); n++;
assert.deepEqual(state('SB-33').gate.harnessRuns, [{ name: 'e2e', mode: 'reused', specs: [], from: { card: 'SB-32', round: 0, at: marker().at } }]); n++;
assert.equal(state('SB-33').gate.harnessesPassed, 1); n++;
assert.equal(fs.readFileSync(markerFile, 'utf8'), markerBefore); n++;
assert.equal(fs.readFileSync(path.join(REPO, '.orchestrate/runs/_suite.json'), 'utf8'), legacyBefore); n++;
has(o, /PASS  harness e2e \(full: closure card\): REUSED from SB-32 r0 .* \(inputs unchanged\)/, 'reuse gate line');
const reusedBrief = fs.readFileSync(state('SB-33').checkerPrompts[0].prompt, 'utf8');
has(reusedBrief, /`node scripts\/e2e\.mjs` \(whole suite, REUSED: inputs identical to SB-32 r0\)/, 'checker describes reuse');
assert.ok(!reusedBrief.includes('The gate already ran these')); n++;
console.log('reuse: unchanged closure inputs reuse without execution or marker writes; checker brief says REUSED');
console.log(o.split('\n').find(line => line.includes('REUSED from')));

expectRun('SB-34', wt => write('app/menu.mjs', 'export const m = 100;\n', wt));
expectRun('SB-35', wt => write('package-lock.json', '{"lockfileVersion":3}\n', wt));
reuseCfg.harnesses[0].command = 'node --no-warnings scripts/e2e.mjs'; saveCfg();
expectRun('SB-36');
mockNodeVersion = 'v999.0.0'; expectRun('SB-37'); mockNodeVersion = null;
write('.env.local', 'LOCAL_TEST_VALUE=changed\n'); expectRun('SB-38');
assert.ok(!fs.readFileSync(markerFile, 'utf8').includes('LOCAL_TEST_VALUE')); n++;
console.log('reuse: covered path, lockfile outside paths, command, mocked Node version and linked env content each force execution; no env content stored');

reuseCfg.harnesses[0].reuse = { maxAgeHours: 1 }; saveCfg();
has(orch(['config']), /reuse: on \(max 1 h\)/, 'config displays custom age');
// The reuse option itself is not an input: a fresh pass survives a max-age policy change.
const policyBefore = runs(); has(closureGate('SB-39'), /REUSED from SB-38/, 'reuse policy excluded from key');
assert.equal(runs(), policyBefore); n++;
const expired = marker(); expired.passes = expired.passes.map(p => ({ ...p, at: new Date(Date.now() - 2 * 3600_000).toISOString() })); saveMarker(expired);
expectRun('SB-40');
console.log('reuse: changing only maxAgeHours retains the input key; passes older than the configured age run again');

reuseCfg.harnesses[0].command = 'node --trace-warnings scripts/e2e.mjs'; saveCfg();
const cleanBeforeFlaky = marker().passes;
fs.writeFileSync(FLAKY, '1');
has(expectRun('SB-41', undefined, 2), /WARN  flaky:/, 'flaky pass still warns');
assert.equal(marker().card, 'SB-41'); n++;
assert.deepEqual(marker().passes, cleanBeforeFlaky); n++;
expectRun('SB-42');
console.log('reuse: flaky PASS updates legacy last-run fields but adds no reusable pass; identical next closure executes');

const beforeFast = runs();
o = runCard('SB-60', wt => write('app/menu.mjs', 'export const m = 60;\n', wt), { checker: false });
has(o, /harness e2e \(fast\)/, 'reuse-enabled harness still uses fast mode');
orch(['gate', 'SB-60']);
assert.equal(runs() - beforeFast, 2); n++;
assert.equal(state('SB-60').gate.harnessRuns[0].mode, 'fast'); n++;
console.log('reuse: fast mode executes on every gate, even with identical inputs');

o = closureGate('SB-43'); has(o, /REUSED from SB-42/, 'merge starts from reused gate');
write(ckr('SB-43'), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', 'SB-43', 'checker']);
write('app/menu.mjs', 'export const m = 200;\n'); g('add', '-A'); g('commit', '-q', '-m', 'base moved after reused gate');
const beforeFinish = runs(); orch(['finish', 'SB-43']);
assert.equal(runs() - beforeFinish, 1); n++;
assert.equal(lastArgs(), '<all>'); n++;
console.log('reuse: moved application base reruns a reused gate entry as a full suite at merge');

// Keep at most 20 newest passes; old key history survives real runs, including a return to an earlier input key.
const crowded = marker();
crowded.passes = Array.from({ length: 20 }, (_, i) => ({ ...crowded.passes[0], key: `old-${i}` })); saveMarker(crowded);
expectRun('SB-44');
assert.equal(marker().passes.length, 20); n++;
assert.equal(marker().passes[0].card, 'SB-44'); n++;
assert.equal(marker().passes.at(-1).key, 'old-18'); n++;
console.log('reuse: clean PASS history is newest first and bounded to 20 records');

const cleanMarker = fs.readFileSync(markerFile, 'utf8');
const cleanCommand = reuseCfg.harnesses[0].command;
for (const [id, command, gateCode] of [
  ['SB-45', 'node -e "process.exit(1)"', 2],
  ['SB-46', 'node -e "process.exit(124)"', 2],
  ['SB-47', 'node -e "process.exit(137)"', 3],
]) {
  reuseCfg.harnesses[0].command = command; saveCfg();
  runCard(id, wt => write('docs/x.md', `# ${id}\n`, wt), { checker: false, gateCode });
  assert.equal(fs.readFileSync(markerFile, 'utf8'), cleanMarker); n++;
}
reuseCfg.harnesses[0].command = cleanCommand;
reuseCfg.checks = ['node -e "process.exit(1)"']; saveCfg();
const beforeFailedCheck = runs();
has(runCard('SB-48', wt => write('docs/x.md', '# failed check\n', wt), { checker: false, gateCode: 2 }), /SKIP  harness e2e: not run, the gate already fails above/, 'fail before harnesses unchanged');
assert.equal(runs(), beforeFailedCheck); n++;
assert.equal(fs.readFileSync(markerFile, 'utf8'), cleanMarker); n++;
reuseCfg.checks = ['node -e 0'];
reuseCfg.harnesses[0].fast.critical = []; saveCfg();
has(runCard('SB-49.1', wt => write('docs/child.md', '# skipped\n', wt), { checker: false }), /SKIP  harness e2e: no changed file under its paths/, 'unrelated card still skips');
// Trigger the harness explicitly, but no spec or critical spec means the fast plan has nothing to run.
write('backlog/tasks/sb-50.1 - Child.md', card('SB-50.1', 'Child', ['app/no-spec.mjs'], 'parent_task_id: SB-50\n'));
const beforeSkip = runs();
has(runCard('SB-50.1', wt => write('app/no-spec.mjs', '// no spec\n', wt), { checker: false }), /fast gate, nothing to run/, 'skip plan never reused');
assert.equal(state('SB-50.1').gate.harnessRuns[0].mode, 'skip'); n++;
assert.equal(runs(), beforeSkip); n++;
console.log('reuse: FAIL, timeout, INFRA and failed checks do not cache a pass; unrelated and empty fast plans still skip');

// Scoped checks and harnesses without a fast plan use the same full-run reuse mechanism.
delete reuseCfg.harnesses[0].fast;
reuseCfg.harnesses[0].kind = 'check'; saveCfg();
const suiteBeforeCheck = fs.readFileSync(path.join(REPO, '.orchestrate/runs/_suite.json'), 'utf8');
expectRun('SB-51');
const beforeCheckReuse = runs();
has(orch(['gate', 'SB-51']), /harness e2e \(full\): REUSED from SB-51 r0/, 'scoped check without fast can reuse');
assert.equal(runs(), beforeCheckReuse); n++;
assert.equal(fs.readFileSync(path.join(REPO, '.orchestrate/runs/_suite.json'), 'utf8'), suiteBeforeCheck); n++;
// A risky path forces full mode for a normal card, and a second gate of the same inputs can reuse it.
reuseCfg.harnesses[0].fast = { critical: ['tests/e2e/02-orders.spec.mjs'] };
reuseCfg.risk.paths = ['app/**']; saveCfg();
write('backlog/tasks/sb-51.1 - Child.md', card('SB-51.1', 'Child', ['app/risky.mjs'], 'parent_task_id: SB-51\n'));
has(runCard('SB-51.1', wt => write('app/risky.mjs', '// risky\n', wt), { checker: false }), /harness e2e \(full: risky paths: app\/risky.mjs\)/, 'risky card runs in full');
const beforeRiskReuse = runs();
has(orch(['gate', 'SB-51.1']), /harness e2e \(full: risky paths: app\/risky.mjs\): REUSED from SB-51.1 r0/, 'risky full plan can reuse');
assert.equal(runs(), beforeRiskReuse); n++;
console.log('reuse: scoped checks, full plans without fast and risky full plans reuse clean passes; suite legacy marker remains separate');

// Correction regressions: corrupt optional history cannot prevent execution, even when reuse is disabled.
delete reuseCfg.harnesses[0].reuse; saveCfg();
fs.writeFileSync(markerFile, '{invalid JSON');
expectRun('SB-52');
assert.deepEqual(Object.keys(marker()).sort(), ['at', 'base', 'card', 'harness']); n++;
assert.equal(marker().card, 'SB-52'); n++;
reuseCfg.harnesses[0].reuse = true; saveCfg();
fs.writeFileSync(markerFile, '{invalid JSON');
expectRun('SB-53');
assert.equal(marker().passes.length, 1); n++;
assert.equal(marker().passes[0].card, 'SB-53'); n++;
console.log('reuse correction: corrupt marker, reuse absent -> RUN; reuse enabled -> RUN and repaired with one pass');

// The fake harness changes its linked input itself. Restoring the pre-run content must not allow reuse.
const linkedBefore = fs.readFileSync(path.join(REPO, '.env.local'), 'utf8');
reuseCfg.harnesses[0].command = `node -e "require('fs').writeFileSync('.env.local', 'LOCAL_TEST_VALUE=mutated\\n')" && node scripts/e2e.mjs`;
saveCfg();
const beforeMutation = marker().passes;
o = expectRun('SB-54');
has(o, /WARN  harness e2e reuse: inputs changed during the run, not recorded/, 'linked mutation warns');
assert.notEqual(fs.readFileSync(path.join(REPO, '.env.local'), 'utf8'), linkedBefore); n++;
assert.deepEqual(marker().passes, beforeMutation); n++;
write('.env.local', linkedBefore);
expectRun('SB-55');
assert.deepEqual(marker().passes, beforeMutation); n++;
write('.env.local', linkedBefore);
console.log('reuse correction: linked input mutated by harness -> no new pass; restored input next gate -> RUN');
console.log(o.split('\n').find(line => line.includes('reuse: inputs changed')));

// Histories are appended after all suites; they must never rewrite a later suite's legacy last-run fields.
delete reuseCfg.harnesses[0].kind;
reuseCfg.harnesses[0].command = 'node scripts/e2e.mjs';
reuseCfg.harnesses.push({ name: 'later', command: 'node --no-warnings scripts/e2e.mjs', when: 'gate', paths: ['app/**'] });
saveCfg();
const legacyFile = path.join(REPO, '.orchestrate/runs/_suite.json');
const laterFile = path.join(REPO, '.orchestrate/runs/_suite-later.json');
expectRun('SB-56', undefined, 2);
assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')), JSON.parse(fs.readFileSync(laterFile, 'utf8'))); n++;
assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).harness, 'later'); n++;
reuseCfg.harnesses[0].command = 'node --trace-warnings scripts/e2e.mjs';
reuseCfg.harnesses[1].reuse = true;
reuseCfg.harnesses[1].command = `node -e ${shq(`require('fs').writeFileSync(${JSON.stringify(FLAKY)}, '1')`)} && node scripts/e2e.mjs`;
saveCfg();
has(expectRun('SB-57', undefined, 3), /WARN  flaky:/, 'later suite has a flaky pass');
const legacyFlaky = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
assert.equal(legacyFlaky.harness, 'later'); n++;
assert.deepEqual(legacyFlaky, JSON.parse(fs.readFileSync(laterFile, 'utf8'))); n++;
assert.deepEqual(Object.keys(legacyFlaky).sort(), ['at', 'base', 'card', 'harness']); n++;
assert.equal(marker().passes[0].card, 'SB-57'); n++;
fs.unlinkSync(FLAKY);
console.log('reuse correction: clean enabled then clean disabled / flaky suite -> legacy last run stays later; no legacy passes');

// Deterministic delayed-save ordering: A passes, B passes and saves, then A saves its history.
const concurrentFile = path.join(base, 'concurrent-suite.json');
const greenA = { base: 'base-A', card: 'A', harness: 'edge', at: '2026-11-10T12:01:00.000Z' };
const greenB = { base: 'base-B', card: 'B', harness: 'edge', at: '2026-11-10T12:02:00.000Z' };
const passFor = green => ({ key: `key-${green.card}`, tree: `tree-${green.card}`, card: green.card, round: 0, at: green.at });
updateSuiteMarker(concurrentFile, greenA);
updateSuiteMarker(concurrentFile, greenB);
updateSuiteMarker(concurrentFile, greenB, passFor(greenB));
updateSuiteMarker(concurrentFile, greenA, passFor(greenA));
updateSuiteMarker(concurrentFile, greenA, passFor(greenA)); // duplicate receipt must not evict another pass
let concurrent = JSON.parse(fs.readFileSync(concurrentFile, 'utf8'));
assert.deepEqual(concurrent, { ...greenB, passes: [passFor(greenB), passFor(greenA)] }); n++;
console.log('reuse correction: A-pass, B-pass-and-save, A-save -> marker.card=B; passes=B,A; duplicates=0');
const tiedFile = path.join(base, 'same-second-suite.json');
const tiedA = { ...greenA, at: greenB.at };
updateSuiteMarker(tiedFile, tiedA);
updateSuiteMarker(tiedFile, greenB);
updateSuiteMarker(tiedFile, greenB, passFor(greenB));
updateSuiteMarker(tiedFile, tiedA, passFor(tiedA));
assert.equal(JSON.parse(fs.readFileSync(tiedFile, 'utf8')).card, 'B'); n++;
console.log('reuse correction: same-second delayed A history append -> last run stays B');

// Even malformed last-run dates must never invoke coercion on stored objects.
const invalidFile = path.join(base, 'invalid-suite.json');
for (const value of [null, 42, 'history', false, { at: { toString: null }, passes: [null] }]) {
  fs.writeFileSync(invalidFile, JSON.stringify(value));
  assert.equal(reusablePass(value, 'K', 72), null); n++;
  updateSuiteMarker(invalidFile, greenA, passFor(greenA));
  assert.deepEqual(JSON.parse(fs.readFileSync(invalidFile, 'utf8')), { ...greenA, passes: [passFor(greenA)] }); n++;
}
console.log('reuse correction 2: null/primitive markers and malformed last-run at -> ignored; repaired without coercion errors');

// Interrupted atomic writes retain the old marker and remove their temporary file.
const atomicFile = path.join(base, 'atomic-suite.json');
updateSuiteMarker(atomicFile, greenA, passFor(greenA));
const atomicBefore = fs.readFileSync(atomicFile, 'utf8');
for (const operation of ['renameSync', 'writeFileSync']) {
  const original = fs[operation];
  fs[operation] = (file, ...args) => {
    if (String(file) === `${atomicFile}.${process.pid}.tmp`) {
      if (operation === 'writeFileSync') original(file, 'partial');
      const error = new Error('fixture'); error.code = operation === 'renameSync' ? 'EIO' : 'ENOSPC'; throw error;
    }
    return original(file, ...args);
  };
  try { assert.throws(() => updateSuiteMarker(atomicFile, greenB, passFor(greenB))); n++; }
  finally { fs[operation] = original; }
  assert.equal(fs.readFileSync(atomicFile, 'utf8'), atomicBefore); n++;
  assert.equal(fs.existsSync(`${atomicFile}.${process.pid}.tmp`), false); n++;
}
console.log('reuse correction 2: atomic rename EIO / partial write ENOSPC -> previous marker intact; no temporary file remains');

// Marker writes use only the project harness lock, including simultaneous real processes.
const harnessModule = new URL('../scripts/lib/harness.mjs', import.meta.url).href;
await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
  const green = { ...greenA, card: `P${i}`, at: `2026-11-10T12:${String(10 + i).padStart(2, '0')}:00.000Z` };
  const source = `import { runHarness, updateSuiteMarker } from ${JSON.stringify(harnessModule)};
    runHarness(${JSON.stringify(REPO)}, { command: 'true' }, ${JSON.stringify(REPO)}, {
      after: () => updateSuiteMarker(${JSON.stringify(concurrentFile)}, ${JSON.stringify(green)}, ${JSON.stringify(passFor(green))})
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', data => { err += data; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`concurrent writer: exit ${code}: ${err}`)));
})));
concurrent = JSON.parse(fs.readFileSync(concurrentFile, 'utf8'));
assert.equal(concurrent.card, 'P7'); n++;
assert.deepEqual(concurrent.passes.map(p => p.card), ['P7', 'P6', 'P5', 'P4', 'P3', 'P2', 'P1', 'P0', 'B', 'A']); n++;
console.log('reuse correction 2: 8 writers serialized by harness.lock -> newest=P7; all 10 receipts preserved');

// Restore one harness for the remaining gate probes.
reuseCfg.harnesses.splice(1);
reuseCfg.harnesses[0].reuse = true;
reuseCfg.harnesses[0].command = 'node scripts/e2e.mjs'; saveCfg();
const incomplete = { key: 'K', at: new Date().toISOString() };
const malformed = [{ passes: [null] }, { passes: 'x' }, [],
  { passes: [incomplete] }, { passes: [{ ...passFor(greenA), at: 'bad' }] },
  { passes: [{ ...passFor(greenA), round: -1 }] }];
for (const [i, stored] of malformed.entries()) {
  assert.equal(reusablePass(stored, 'K', 72), null); n++;
  saveMarker(stored);
  expectRun(`SB-${61 + i}`);
  assert.equal(marker().passes.length, 1); n++;
  assert.equal(marker().passes[0].card, `SB-${61 + i}`); n++;
}
console.log('reuse correction 2: passes=[null], passes="x", [], incomplete receipt, bad at, negative round -> RUN; repaired to one valid receipt');

// Hold the real lock in another process; the suite and its hooks must see B after that owner releases it.
const harnessLock = path.join(REPO, '.orchestrate/harness.lock');
const heldSignal = path.join(base, 'lock-held');
const runSignal = path.join(base, 'command-held');
const releaseSignal = path.join(base, 'release-command');
const observed = path.join(base, 'observed-input');
const inputA = 'LOCAL_TEST_VALUE=A\n', inputB = 'LOCAL_TEST_VALUE=B\n';
write('.env.local', inputA);
const waitSource = `const fs=require('fs');const pause=new Int32Array(new SharedArrayBuffer(4));
  fs.writeFileSync(${JSON.stringify(runSignal)}, '1');
  while(!fs.existsSync(${JSON.stringify(releaseSignal)})) Atomics.wait(pause,0,0,10);
  fs.writeFileSync(${JSON.stringify(observed)}, fs.readFileSync('.env.local'))`;
reuseCfg.harnesses[0].command = `node -e ${shq(waitSource)} && node scripts/e2e.mjs`; saveCfg();
const holder = spawn(process.execPath, ['-e', `const fs=require('fs');
  fs.mkdirSync(${JSON.stringify(harnessLock)});fs.writeFileSync(${JSON.stringify(path.join(harnessLock, 'pid'))},String(process.pid));
  fs.writeFileSync(${JSON.stringify(heldSignal)},'1');setTimeout(()=>{
    fs.writeFileSync(${JSON.stringify(path.join(REPO, '.env.local'))},${JSON.stringify(inputB)});
    fs.rmSync(${JSON.stringify(harnessLock)},{recursive:true});
  },1200);`], { stdio: ['ignore', 'pipe', 'pipe'] });
const holderDone = new Promise((resolve, reject) => { holder.on('error', reject); holder.on('close', code => code === 0 ? resolve() : reject(new Error(`holder exit ${code}`))); });
while (!fs.existsSync(heldSignal)) await new Promise(resolve => setTimeout(resolve, 10));
// The synchronous gate is safe here: its holder and command controller are independent processes.
const controller = spawn(process.execPath, ['-e', `const fs=require('fs');const timer=setInterval(()=>{
  if(fs.existsSync(${JSON.stringify(runSignal)})) {
    fs.writeFileSync(${JSON.stringify(releaseSignal)},'1');clearInterval(timer);
  }
},10);setTimeout(()=>process.exit(),15000).unref();`], { stdio: 'ignore' });
const controllerDone = new Promise((resolve, reject) => { controller.on('error', reject); controller.on('close', code => code === 0 ? resolve() : reject(new Error(`controller exit ${code}`))); });
o = expectRun('SB-67');
await Promise.all([holderDone, controllerDone]);
assert.equal(fs.readFileSync(observed, 'utf8'), inputB); n++;
const runState = state('SB-67');
assert.equal(marker().passes[0].key, harnessInputKey(reuseCfg.harnesses[0], runState.gate.tree, W('SB-67'), runState.links)); n++;
write('.env.local', inputA);
expectRun('SB-68');
assert.equal(fs.readFileSync(observed, 'utf8'), inputA); n++;
console.log('reuse correction 2: live process holds harness.lock; A -> B while waiting -> recorded B; restore A -> RUN');

// The execution before hook must also run after a wait occurring BETWEEN lookup and execution.
let insideLock = false;
const lockProbe = path.join(base, 'hook-probe');
runHarness(REPO, { command: 'true' }, REPO, {
  before: () => { insideLock = fs.existsSync(path.join(harnessLock, 'pid')); fs.writeFileSync(lockProbe, 'before'); },
  after: result => {
    assert.equal(insideLock, true); n++;
    assert.equal(fs.existsSync(path.join(harnessLock, 'pid')), true); n++;
    assert.equal(result.code, 0); n++;
    assert.equal(fs.readFileSync(lockProbe, 'utf8'), 'before'); n++;
  },
});
assert.equal(fs.existsSync(harnessLock), false); n++;
console.log('reuse correction 2: before and after hooks both execute while harness.lock is held');

// Force contention specifically after lookup releases its lock, reproducing the checker's A/B/A schedule.
write('.env.local', inputA);
const restoreSignal = path.join(base, 'restore-after-execution');
const lockEvents = path.join(base, 'created-locks');
const actorReady = path.join(base, 'actor-ready');
const actorSource = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(harnessLock)});
  fs.writeFileSync(${JSON.stringify(path.join(harnessLock, 'pid'))},String(process.pid));
  fs.writeFileSync(${JSON.stringify(actorReady)},'1');
  setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(REPO, '.env.local'))},${JSON.stringify(inputB)});
    fs.rmSync(${JSON.stringify(harnessLock)},{recursive:true});},400);`;
orchPrelude = `import fs from 'node:fs';import {spawn} from 'node:child_process';
  const remove=fs.rmSync, mkdir=fs.mkdirSync;let releases=0;
  fs.mkdirSync=function(file,...args){
    if(String(file).endsWith('.lock')) fs.appendFileSync(${JSON.stringify(lockEvents)},String(file)+'\\n');
    return mkdir.call(this,file,...args);
  };
  fs.rmSync=function(file,...args){const r=remove.call(this,file,...args);
    if(file===${JSON.stringify(harnessLock)}) {
      releases++;
      if(releases===1) {
        spawn(process.execPath,['-e',${JSON.stringify(actorSource)}],{stdio:'ignore'});
        const pause=new Int32Array(new SharedArrayBuffer(4));
        while(!fs.existsSync(${JSON.stringify(actorReady)})) Atomics.wait(pause,0,0,10);
      }
      if(releases===2) {fs.writeFileSync(${JSON.stringify(path.join(REPO, '.env.local'))},${JSON.stringify(inputA)});
        fs.writeFileSync(${JSON.stringify(restoreSignal)},'1');}
    }
    return r;
  };`;
reuseCfg.harnesses[0].command = `node -e ${shq(`require('fs').writeFileSync(${JSON.stringify(observed)},require('fs').readFileSync('.env.local'))`)} && node scripts/e2e.mjs`; saveCfg();
try { expectRun('SB-70'); } finally { orchPrelude = null; }
assert.equal(fs.existsSync(restoreSignal), true); n++;
assert.equal(fs.readFileSync(observed,'utf8'), inputB); n++;
assert.equal(fs.readFileSync(path.join(REPO, '.env.local'),'utf8'), inputA); n++;
const scheduledState=state('SB-70');
assert.notEqual(marker().passes[0].key,harnessInputKey(reuseCfg.harnesses[0],scheduledState.gate.tree,W('SB-70'),scheduledState.links)); n++;
const scheduledReceipt=marker().passes[0];
write('.env.local',inputB);
assert.equal(scheduledReceipt.key,harnessInputKey(reuseCfg.harnesses[0],scheduledState.gate.tree,W('SB-70'),scheduledState.links)); n++;
write('.env.local',inputA);
expectRun('SB-71');
assert.equal(fs.readFileSync(observed,'utf8'),inputA); n++;
assert.ok(fs.readFileSync(lockEvents,'utf8').trim().split('\n').every(file=>file===harnessLock)); n++;
console.log('reuse correction 2: lookup A -> lock wait -> suite sees B -> restore A at release; recorded B only; next A gate RUNs; only harness.lock created');

// A suite that restores A inside its command after waiting for B has different execution endpoints.
write('.env.local',inputB);
const priorRestoration=marker().passes;
reuseCfg.harnesses[0].command = `node scripts/e2e.mjs && node -e ${shq(`require('fs').writeFileSync('.env.local',${JSON.stringify(inputA)})`)}`; saveCfg();
o=expectRun('SB-72');
has(o,/inputs changed during the run, not recorded/,'suite restores old content before releasing lock');
assert.deepEqual(marker().passes,priorRestoration); n++;
console.log('reuse correction 2: suite starts on B and restores A inside command -> before/after differ; no reusable receipt');

// Read and hashing failures are optional-history warnings even after the command succeeds.
for (const [id, target, when] of [['SB-73', markerFile, 0], ['SB-74', path.join(W('SB-74'), '.env.local'), 0],
  ['SB-75', path.join(W('SB-75'), '.env.local'), 2]]) {
  reuseCfg.harnesses[0].command='node scripts/e2e.mjs'; saveCfg();
  orchPrelude=`import fs from 'node:fs';const read=fs.readFileSync;let calls=0;
    fs.readFileSync=function(file,...args){if(file===${JSON.stringify(target)} && ++calls>${when}) {
      const error=new Error('fixture');error.code='EACCES';throw error;
    }return read.call(this,file,...args);};`;
  try { o=expectRun(id); } finally { orchPrelude=null; }
  assert.equal(state(id).gate.pass,true); n++;
  has(o,/WARN  harness e2e reuse:/,'history read or hashing failure warns');
  if(when===2) has(o,/history not recorded \(input verification failed\)/,'after-command hash error warns');
  else has(o,/lookup unavailable, running suite normally/,'lookup failure falls back to execution');
}
console.log('reuse correction 2: marker EACCES, lookup/before hash EACCES, after-command hash EACCES -> WARN; gate PASS');

// A passing command can make the marker directory unwritable; optional history never changes PASS.
const runsDir = path.dirname(markerFile);
const previousMarker = fs.readFileSync(markerFile, 'utf8');
reuseCfg.harnesses[0].command = `node scripts/e2e.mjs && node -e ${shq(`require('fs').chmodSync(${JSON.stringify(runsDir)}, 0o555)`)}`; saveCfg();
try {
  o = expectRun('SB-69');
  has(o, /WARN  harness e2e reuse: history not recorded \(marker update failed\)/, 'unwritable marker warns');
  assert.equal(state('SB-69').gate.pass, true); n++;
  assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker); n++;
} finally { fs.chmodSync(runsDir, 0o755); }
console.log('reuse correction 2: marker directory chmod 555 after clean command -> gate PASS; history WARN; previous marker intact');
console.log(o.split('\n').find(line => line.includes('history not recorded')));

const lockFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === 'node_modules' || entry.name === '.git') return [];
  const full = path.join(directory, entry.name);
  return [...(entry.name.endsWith('.lock') ? [full] : []), ...(entry.isDirectory() ? lockFiles(full) : [])];
});
assert.deepEqual(lockFiles(path.join(REPO, '.orchestrate')), []); n++;
assert.deepEqual(lockFiles(base).filter(file => /_suite.*\.lock$/.test(file)), []); n++;
console.log('reuse correction 2: no marker *.lock created; project harness.lock released after every suite');

// Exercise the exact tree-key contract without running additional suites. These are throwaway worktree files.
const keyWt = W('SB-44');
const treeIn = () => {
  for (const args of [['add', '-A'], ['write-tree']]) {
    const r = spawnSync('git', args, { cwd: keyWt, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
    if (args[0] === 'write-tree') return r.stdout.trim();
  }
};
const h = reuseCfg.harnesses[0];
const key = (tree, harness = h) => harnessInputKey(harness, tree, keyWt, state('SB-44').links);
let keyTree = treeIn();
let priorKey = key(keyTree);
write('node_modules/untracked-cache.txt', 'changed directory link\n');
assert.equal(key(keyTree), priorKey); n++;
write('docs/outside-paths.md', '# outside\n', keyWt);
let nextTree = treeIn();
assert.equal(key(nextTree), priorKey); n++;
assert.notEqual(key(keyTree, { command: 'true' }), key(nextTree, { command: 'true' })); n++;
assert.notEqual(key(keyTree, { command: 'true', paths: [] }), key(nextTree, { command: 'true', paths: [] })); n++;
keyTree = nextTree;
for (const file of ['npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'nested/package-lock.json', 'app/café.txt', 'app/with space.txt', 'app/with\ttab.txt', 'app/with\nnewline.txt', 'app/trailing newline\n']) {
  write(file, 'input\n', keyWt); nextTree = treeIn();
  assert.notEqual(key(nextTree), key(keyTree), `key includes exact path ${JSON.stringify(file)}`); n++;
  keyTree = nextTree;
}
priorKey = key(keyTree);
fs.chmodSync(path.join(keyWt, 'app/menu.mjs'), 0o755);
nextTree = treeIn();
assert.notEqual(key(nextTree), priorKey, 'file mode contributes to input key'); n++;
fs.unlinkSync(path.join(keyWt, 'app/café.txt'));
keyTree = treeIn();
assert.notEqual(key(keyTree), key(nextTree), 'deleted input changes the key'); n++;
console.log('reuse: exact Unicode/space/tab/newline names, file modes, deletions and every lockfile affect keys; absent paths covers the whole tree; directory links do not');

console.log(`e2e-fast: ${n} checks passed in ${REPO}`);
