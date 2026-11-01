// End to end for the fast gate: card specs + critical specs, risky paths and closure cards in full, one rerun of
// failed specs (flaky), and the cards merged since the last whole-suite pass. node test/e2e-fast.mjs [dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fast-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
const FLAKY = path.join(base, 'flaky-once');
const ARGS = path.join(base, 'harness-args.log');
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base } });
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

console.log(`e2e-fast: ${n} checks passed in ${REPO}`);
