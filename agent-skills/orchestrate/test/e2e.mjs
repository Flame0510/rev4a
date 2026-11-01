// End to end on a throwaway repository with a Backlog.md backlog shaped like tourguide's (statuses, SB prefix,
// modified_files, ISO dates). Workers and checkers are simulated by writing files. node test/e2e.mjs [dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'fake-project');
const HOME = path.join(base, 'home'); // no OpenClaw config: models come from --models
fs.mkdirSync(REPO, { recursive: true }); fs.mkdirSync(HOME);

let steps = 0;
function orch(args, { code = 0, cwd = REPO } = {}) {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME } });
  const text = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}, wanted ${code}:\n${text}`);
  steps++;
  return text;
}
function g(args, cwd = REPO) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (rel, text, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const read = (rel, root = REPO) => fs.readFileSync(path.join(root, rel), 'utf8');
const taskFile = id => path.join('backlog/tasks', fs.readdirSync(path.join(REPO, 'backlog/tasks')).find(f => f.toLowerCase().startsWith(`${id.toLowerCase()} `)));
const status = id => read(taskFile(id)).match(/^status: (.*)$/m)[1];
const has = (text, re, label) => { assert.match(text, re, label); steps++; };

function task({ id, title, status: st = 'To Do', deps = '[]', owned = [], checks = null, priority = 'medium', ordinal }) {
  return `---
id: ${id}
title: ${title}
status: ${st}
assignee: []
created_date: '2026-10-20T19:36:00Z'
labels:
  - wave-1
dependencies: ${deps}
${owned.length ? `modified_files:\n${owned.map(o => `  - ${o}`).join('\n')}\n` : ''}${checks ? `checks:\n${checks.map(c => `  - '${c}'`).join('\n')}\n` : ''}priority: ${priority}
ordinal: ${ordinal}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
${title}. Keep the public API.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No Italian word in the owned files (word-list script)
- [ ] #2 \`npm run check\` passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Translate the strings.
<!-- SECTION:PLAN:END -->
`;
}

// ---------------------------------------------------------------- the fake project
g(['init', '-q', '-b', 'develop']);
g(['config', 'user.name', 'Test']); g(['config', 'user.email', 'test@example.invalid']);
write('package.json', JSON.stringify({ name: 'fake', private: true, type: 'module', scripts: { check: 'node scripts/check.mjs', e2e: 'playwright test', 'test:db:remote': 'node x.mjs' } }, null, 2));
write('playwright.config.mjs', "export default { testDir: './tests/e2e' };\n");
write('tests/e2e/greet.spec.mjs', '// stands in for a Playwright spec\n');
write('.github/workflows/e2e.yml', 'jobs:\n  e2e:\n    steps:\n      - run: npx playwright test\n');
// Stands in for Playwright: checks the page text, writes a report folder like Playwright does.
write('scripts/fake-e2e.mjs', `import fs from 'node:fs';
const { greet } = await import('../src/a/greet.mjs');
if (!fs.readFileSync('.env.local', 'utf8').includes('E2E_SECRET')) { console.error('e2e: no .env.local'); process.exit(1); }
fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/last-run.json', '{}');
if (greet('Ana') !== 'Hello, Ana') { console.error('e2e: the page says ' + greet('Ana')); process.exit(1); }
if (fs.existsSync('src/e/e.mjs') && fs.readFileSync('src/e/e.mjs', 'utf8').includes('BROKEN')) { console.error('e2e: page e is broken'); process.exit(1); }
console.log('e2e: 3 passed');
`);
write('.gitignore', 'node_modules/\n');
write('scripts/check.mjs', `import fs from 'node:fs';
const { greet } = await import('../src/a/greet.mjs');
if (typeof greet('x') !== 'string') { console.error('greet broken'); process.exit(1); }
if (fs.existsSync('src/a/x.mjs') && fs.existsSync('FORBID_X')) { console.error('x.mjs is forbidden on develop'); process.exit(1); }
console.log('check ok');
`);
write('scripts/no-italian.mjs', `import fs from 'node:fs'; import path from 'node:path';
const WORDS = /\\b(ciao|grazie|errore|benvenuto)\\b/i; let bad = 0; // lang-ok: Italian copy is what this fake i18n check looks for
const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else fs.readFileSync(p, 'utf8').split('\\n').forEach((l, i) => { if (WORDS.test(l)) { bad++; console.log(p + ':' + (i + 1) + ': ' + l.trim()); } }); });
walk(process.argv[2]); console.log(bad + ' Italian word(s)'); process.exit(bad ? 1 : 0);
`);
write('src/a/greet.mjs', "export const greet = name => `Ciao, ${name}`;\nexport const thanks = () => 'Grazie';\n"); // lang-ok: Italian copy is what this fake i18n check looks for
write('src/b/menu.mjs', "export const title = 'Menu';\n");
write('README.md', '# Fake\n');
write('.gitignore', 'node_modules/\n.env.local\n');
write('.env.local', 'E2E_SECRET=not-real\n');
write('node_modules/fake-dep/index.js', 'module.exports = 1;\n');
write('backlog/config.yml', `project_name: "Fake"
default_status: "To Do"
statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked", "Cancelled"]
labels: []
date_format: yyyy-mm-dd
auto_commit: false
task_prefix: "SB"
`);
write('backlog/tasks/sb-1 - Scaffold.md', task({ id: 'SB-1', title: 'Scaffold', st: 'Done', owned: ['package.json'], ordinal: 1000 }).replace('status: To Do', 'status: Done'));
write('backlog/tasks/sb-2 - Translate-greet.md', task({ id: 'SB-2', title: 'Translate greet to English', deps: '[SB-1]', owned: ['src/a/**'], checks: ['node scripts/no-italian.mjs src/a'], priority: 'high', ordinal: 2000 }));
write('backlog/tasks/sb-3 - Docs.md', task({ id: 'SB-3', title: 'Document greet', deps: '\n  - SB-2', owned: ['docs/**'], ordinal: 3000 }));
write('backlog/tasks/sb-4 - Extra.md', task({ id: 'SB-4', title: 'Add x helper', owned: ['src/a/x.mjs'], ordinal: 4000 }));
write('backlog/tasks/sb-5 - Vague.md', task({ id: 'SB-5', title: 'Vague task without owned files', ordinal: 5000 }));
write('backlog/tasks/sb-6 - Everything.md', task({ id: 'SB-6', title: 'Normalize the whole repository', owned: ['src/**', 'scripts/**', "'*.json'", 'backlog/**'], ordinal: 6000 }));
write('backlog/tasks/sb-7 - Orphan.md', task({ id: 'SB-7', title: 'Depends on a missing task', deps: '[SB-99]', owned: ['src/b/**'], ordinal: 7000 }));
g(['add', '-A']); g(['reset', '-q', 'node_modules']); g(['commit', '-q', '-m', 'fake project']);
const sb2Before = read(taskFile('SB-2'));

// ---------------------------------------------------------------- config
let o = orch(['init', '--models', 'openai/gpt-6.1-sol,rev4a/deepseek/deepseek-flash']);
has(o, /worker rev4a\/deepseek\/deepseek-flash · checker openai\/gpt-6.1-sol/, 'roles proposed');
has(o, /checks: npm run check/, 'check command detected');
has(o, /inCheck="In Check"/, 'statuses from backlog/config.yml');
has(o, /base branch: develop/, 'base branch = current');
has(o, /links node_modules, \.env\.local/, 'untracked env file linked');
has(o, /note: linked into each worktree, never copied and never staged: \.env\.local/, 'env link explained');
orch(['init'], { code: 1 }); // no silent overwrite
has(orch(['next'], { code: 3 }), /not confirmed/, 'nothing runs before the owner confirms');
has(o, /harness e2e: npm run e2e · on gate when a change touches src\/\*\*, tests\/e2e\/\*\*, playwright\.config\.mjs/, 'Playwright detected, testDir from its config');
has(o, /note: other test scripts, not used by the gate .*: test:db:remote/, 'other test scripts suggested, not added');
has(o, /note: CI runs end-to-end tests in: e2e\.yml/, 'CI workflow noticed');
has(o, /run each harness once on develop \(orch harness e2e\)/, 'baseline run proposed');
assert.ok(read('.git/info/exclude').includes('/test-results/'), 'harness output excluded');
orch(['config', '--set', 'harnesses.0.command=node scripts/fake-e2e.mjs']);
const configBeforeInvalidArtifact = read('.orchestrate/config.json');
has(orch(['config', '--set', 'artifacts.disposable=["../node_modules"]'], { code: 1 }), /invalid disposable artifact pattern/, 'invalid artifact policy rejected before saving');
assert.equal(read('.orchestrate/config.json'), configBeforeInvalidArtifact, 'invalid artifact assignment leaves existing config byte-identical');
has(orch(['config']), /artifacts: disabled · reserve 0 bytes · disposable \(none\)/, 'owner sees artifact cleanup policy');
o = orch(['harness', 'e2e'], { code: 2 });
has(o, /harness e2e in .*: FAIL \(exit 1\)/, 'baseline: the base branch fails the harness');
has(o, /e2e: the page says Ciao, Ana/, 'its output tail');
has(o, /fix the harness .* before any task depends on it/, 'baseline advice');
if (process.env.ORCH_TEST_ARTIFACTS === '1') {
  orch(['config', '--set', 'artifacts.enabled=true']);
  orch(['config', '--set', 'artifacts.minFreeBytes=0']);
  orch(['config', '--set', 'artifacts.disposable=["*/runtime/.next","*/node_modules"]']);
}
orch(['config', '--confirm']);
assert.ok(read('.git/info/exclude').includes('/.orchestrate/runs/'));

// ---------------------------------------------------------------- selection
o = orch(['next', '--all']);
has(o, /^SB-2 {2}Translate greet/m, 'SB-2 first (high priority)');
has(o, /^SB-4 /m, 'SB-4 eligible');
has(o, /not SB-3: waits for SB-2 \(To Do\)/, 'dependency in a block list');
has(o, /not SB-5: no modified_files/, 'no owned files');
has(o, /not SB-6: too broad: owns \d+% of the tracked files, split it/, 'whole-repo task refused');
has(o, /not SB-7: dependency SB-99 not found/, 'unknown dependency');
has(o, /next: orch start SB-2/, 'next action');

// ---------------------------------------------------------------- SB-2, round 0: out of scope
o = orch(['start', 'SB-2']);
const WT = path.resolve(REPO, '../.worktrees/orch-SB-2');
assert.ok(fs.existsSync(path.join(WT, 'src/a/greet.mjs')), 'worktree created');
assert.ok(fs.lstatSync(path.join(WT, 'node_modules')).isSymbolicLink(), 'node_modules linked');
assert.ok(fs.lstatSync(path.join(WT, '.env.local')).isSymbolicLink(), '.env.local linked');
assert.equal(status('SB-2'), 'In Progress');
has(o, /delegate the worker to a separate OpenClaw sub-agent session — this is OpenClaw delegation of a whole card, required by this skill and its owner \(own lifecycle, completion delivered to you, visible to the owner\), not internal legwork, so use the OpenClaw tool sessions_spawn and NOT a native spawn_agent: runtime "subagent", label "SB-2 worker r0", taskName "t-sb-2-worker-r0", model "rev4a\/deepseek\/deepseek-flash", cwd "[^"]+orch-SB-2", runTimeoutSeconds 3600, task "Read [^"]+worker-r0\.md and do what it says\."; then wait with sessions_yield/, 'worker action: sessions_spawn with cwd and timeout');
const runs = path.join(REPO, '.orchestrate/runs/SB-2');
const prompt0 = read('prompts/worker-r0.md', runs);
has(prompt0, /src\/a\/\*\*/, 'owned globs in the worker brief');
has(prompt0, /npm run check\nnode scripts\/no-italian.mjs src\/a/, 'config and task checks in the brief');
has(prompt0, /Translate greet to English\. Keep the public API\./, 'description from the section markers');
orch(['start', 'SB-2'], { code: 1 }); // a second coordinator cannot start it again
has(orch(['next', '--all']), /not SB-4: overlaps SB-2 \(In Progress\): src\/a\/x\.mjs \/ src\/a\/\*\*/, 'overlap with a running task');
assert.equal(g(['status', '--porcelain', '--', 'src', 'README.md']), '', 'main checkout untouched');

write('src/a/greet.mjs', "export const greet = name => `Hello, ${name}`;\nexport const thanks = () => 'Grazie';\n", WT); // lang-ok: Italian copy is what this fake i18n check looks for
write('README.md', '# Fake, edited by the worker\n', WT);
orch(['record', 'SB-2', 'worker'], { code: 1 }); // no report yet
write('.orchestrate/runs/SB-2/inbox/worker.md', 'Changed: greet.mjs\nRan: npm run check: pass\n');
orch(['record', 'SB-2', 'worker']);
o = orch(['gate', 'SB-2'], { code: 2 });
has(o, /FAIL {2}scope: 1 file\(s\) outside the owned files: README\.md/, 'scope gate');
has(o, /FAIL {2}check 2: node scripts\/no-italian\.mjs src\/a -> exit 1/, 'task check fails on the leftover Italian');
has(o, /PASS {2}check 1: npm run check/, 'project check');
has(o, /SKIP {2}harness e2e: not run, the gate already fails above/, 'no harness run on a gate that already fails');
assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-2/logs/gate-r0-harness-e2e.log')), 'the harness did not run');
has(o, /next: orch fix SB-2/, 'fix next');
orch(['record', 'SB-2', 'checker'], { code: 1 }); // no checker after a failing gate
assert.equal(fs.existsSync(path.join(WT, 'node_modules/fake-dep')), true);
assert.ok(!g(['diff', '--cached', '--name-only'], WT).includes('node_modules'), 'the link is never staged');

// ---------------------------------------------------------------- round 1: gate passes, the checker brings no evidence
o = orch(['fix', 'SB-2']);
has(o, /round 1\/2/, 'round counter');
const fix1 = read('prompts/fix-r1.md', runs);
has(fix1, /README\.md/, 'gate findings in the fix brief');
has(fix1, /# Task SB-2 — Translate greet/, 'the worker brief repeated');
g(['checkout', '-q', 'HEAD', '--', 'README.md'], WT); g(['reset', '-q'], WT);
write('src/a/greet.mjs', "export const greet = name => `Hello, ${name}`;\nexport const thanks = () => 'Thanks';\n", WT);
write('.orchestrate/runs/SB-2/inbox/worker.md', 'Changed: greet.mjs\n');
orch(['record', 'SB-2', 'worker', '--tokens', '1200']);
o = orch(['gate', 'SB-2']);
has(o, /gate SB-2 round 1: 1 file\(s\), \+2 -2/, 'counts by the script');
has(o, /GATE: PASS/, 'gate passes');
assert.equal(status('SB-2'), 'In Check');
has(o, /delegate the checker a to a separate OpenClaw sub-agent session[^\n]*NOT a native spawn_agent: runtime "subagent", label "SB-2 checker a r1", taskName "t-sb-2-checker-a-r1", model "openai\/gpt-6.1-sol", cwd "[^"]+orch-SB-2", runTimeoutSeconds 1800/, 'checker action: sessions_spawn');
const chk = read('prompts/checker-r1-a.md', runs);
has(chk, /git -C .*orch-SB-2 diff --cached [0-9a-f]{40}/, 'checker reads the staged diff');
has(chk, /do not fail the work because of its wording, counts/, 'paperwork rule');
write(ckr('SB-2'), 'Looks fine.\nVERDICT: PASS\n');
o = orch(['record', 'SB-2', 'checker']);
has(o, /NEEDS EVIDENCE \(PASS without EXECUTED lines\)/, 'PASS without evidence is downgraded');
orch(['finish', 'SB-2'], { code: 1 });
has(orch(['finish', 'SB-2', '--approved-by', 'the maintainer'], { code: 1 }), /not ready/, 'no merge after a rejecting checker');

// ---------------------------------------------------------------- round 2: evidence, then the merge
orch(['fix', 'SB-2']);
write('src/a/greet.mjs', "export const greet = (name = 'guest') => `Hello, ${name}`;\nexport const thanks = () => 'Thanks';\n", WT);
write('.orchestrate/runs/SB-2/inbox/worker.md', 'Changed: default name\n');
orch(['record', 'SB-2', 'worker']);
orch(['gate', 'SB-2']);
write('src/a/greet.mjs', '// sneaked in after the gate\n', WT);
has(orch(['record', 'SB-2', 'checker', '--from', path.join(base, 'nope.md')], { code: 1 }), /no report at/, 'missing --from file');
write('chk.md', 'EXECUTED: node -e "greet()" -> Hello, guest\n- EXECUTED: node -e "greet(\'\')" -> Hello, \n**VERDICT: PASS**\n', base);
has(orch(['record', 'SB-2', 'checker', '--from', path.join(base, 'chk.md')], { code: 1 }), /changed after the gate/, 'checker verdict refused on a changed tree');
write('src/a/greet.mjs', "export const greet = (name = 'guest') => `Hello, ${name}`;\nexport const thanks = () => 'Thanks';\n", WT);
o = orch(['record', 'SB-2', 'checker', '--from', path.join(base, 'chk.md')]);
has(o, /checker a: PASS, 2 EXECUTED/, 'evidence accepted');
has(o, /ask the owner for the merge ok/, 'merge needs the owner');
has(orch(['status', 'SB-2']), /phase ready · round 2\/2 · gate PASS \(1 files \+2 -2, checks 2\/2\)/, 'status line');
write('src/b/menu.mjs', "export const title = 'Menu!';\n", WT);
has(orch(['finish', 'SB-2', '--approved-by', 'the maintainer'], { code: 1 }), /changed after the gate/, 'no merge of an unchecked tree');
g(['checkout', '-q', 'HEAD', '--', 'src/b/menu.mjs'], WT); g(['reset', '-q'], WT);
g(['checkout', '-q', '-b', 'side']);
has(orch(['finish', 'SB-2', '--approved-by', 'the maintainer'], { code: 1 }), /not develop/, 'never switches branches');
g(['checkout', '-q', 'develop']);
const before = g(['rev-parse', 'HEAD']);
o = orch(['finish', 'SB-2', '--approved-by', 'the maintainer']);
has(o, /merged SB-2 into develop/, 'merged');
const parents = g(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
assert.equal(parents.length, 3, 'a --no-ff merge commit');
assert.equal(parents[1], before);
has(g(['log', '-1', '--format=%B']), /Approved by the maintainer\./, 'approval in the merge commit');
assert.equal(read('src/a/greet.mjs'), "export const greet = (name = 'guest') => `Hello, ${name}`;\nexport const thanks = () => 'Thanks';\n");
assert.equal(status('SB-2'), 'Done');
assert.ok(!fs.existsSync(WT), 'worktree removed');
assert.equal(g(['branch', '--list', 'orch/SB-2']), '', 'merged branch deleted');
assert.ok(fs.existsSync(path.join(REPO, 'node_modules/fake-dep/index.js')), 'the real node_modules survived the cleanup');

// The task file: only status, updated_date and the notes changed.
const after = read(taskFile('SB-2'));
const strip = t => t.replace(/^status:.*\n/m, '').replace(/^updated_date:.*\n/m, '').replace(/\n## Implementation Notes[\s\S]*$/, '');
assert.equal(strip(after), strip(sb2Before), 'the rest of the task file is byte for byte');
has(after, /^updated_date: '2\d{3}-\d\d-\d\dT\d\d:\d\d:00Z'$/m, 'ISO date like the file');
const notes = after.split('<!-- SECTION:NOTES:BEGIN -->')[1].split('<!-- SECTION:NOTES:END -->')[0].trim().split('\n');
has(notes.join('\n'), /orch: merged into develop as [0-9a-f]{9}, approved by the maintainer; 2 correction round\(s\)/, 'merge note');
assert.ok(notes.length <= 12, `notes stay short (${notes.length} lines)`);

// ---------------------------------------------------------------- after the merge
o = orch(['next', '--all']);
has(o, /^SB-3 /m, 'SB-3 unblocked by SB-2 Done');
has(o, /^SB-4 /m, 'SB-4 no longer overlaps');

// SB-4: develop moves on and the merged result fails the check -> merge aborted, develop untouched.
orch(['start', 'SB-4']);
const WT4 = path.resolve(REPO, '../.worktrees/orch-SB-4');
write('src/a/x.mjs', 'export const x = 1;\n', WT4);
write('.orchestrate/runs/SB-4/inbox/worker.md', 'Changed: x.mjs\n');
orch(['record', 'SB-4', 'worker']);
orch(['gate', 'SB-4']);
write(ckr('SB-4'), 'EXECUTED: node -e "x" -> 1\nVERDICT: PASS WITH NOTES\n');
orch(['record', 'SB-4', 'checker']);
write('FORBID_X', 'on develop only\n'); g(['add', 'FORBID_X']); g(['commit', '-q', '-m', 'develop moved on']);
const head4 = g(['rev-parse', 'HEAD']);
has(orch(['finish', 'SB-4', '--approved-by', 'the maintainer'], { code: 2 }), /fails on the merged result.*Merge aborted/, 'check on the merge');
assert.equal(g(['rev-parse', 'HEAD']), head4, 'develop untouched');
assert.ok(!fs.existsSync(path.join(REPO, '.git/MERGE_HEAD')), 'no merge left half done');
assert.ok(!fs.existsSync(path.join(REPO, 'src/a/x.mjs')), 'no merged file left behind');
orch(['park', 'SB-4'], { code: 1 });
orch(['park', 'SB-4', '--reason', 'conflicts with FORBID_X on develop']);
assert.equal(status('SB-4'), 'Blocked');
assert.ok(fs.existsSync(WT4), 'parked worktree kept');

// SB-3: the round limit.
orch(['start', 'SB-3']);
for (const r of [0, 1, 2]) {
  write('.orchestrate/runs/SB-3/inbox/worker.md', `round ${r}: did nothing\n`);
  orch(['record', 'SB-3', 'worker']);
  has(orch(['gate', 'SB-3'], { code: 2 }), /FAIL {2}nothing changed against the base/, 'empty work fails');
  if (r < 2) orch(['fix', 'SB-3']);
}
o = orch(['fix', 'SB-3'], { code: 3 });
has(o, /round limit reached \(2\/2\) and the gate fails, so it cannot be accepted/, 'limit reached: the coordinator decides');
has(orch(['finish', 'SB-3', '--approved-by', 'the maintainer', '--override', 'just ship it'], { code: 1 }), /no passing gate/, 'override never skips the gate');

// SB-8: a project hook refuses the merge commit -> merge aborted. Notes reach the worker brief.
write('.orchestrate/NOTES.md', 'npm here needs --include=dev.\n');
write('backlog/tasks/sb-8 - Hooked.md', task({ id: 'SB-8', title: 'Add c', owned: ['src/c/**'], ordinal: 8000 }));
g(['add', 'backlog/tasks/sb-8 - Hooked.md']); g(['commit', '-q', '-m', 'SB-8']);
orch(['start', 'SB-8']);
has(read('.orchestrate/runs/SB-8/prompts/worker-r0.md'), /## Project notes\nnpm here needs --include=dev\./, 'project notes in the brief');
const WT8 = path.resolve(REPO, '../.worktrees/orch-SB-8');
write('src/c/c.mjs', 'export const c = 3;\n', WT8);
write('.orchestrate/runs/SB-8/inbox/worker.md', 'Changed: c.mjs\n');
orch(['record', 'SB-8', 'worker']); orch(['gate', 'SB-8']);
write(ckr('SB-8'), 'EXECUTED: node -e "c" -> 3\nVERDICT: PASS\n');
orch(['record', 'SB-8', 'checker']);
write('.git/hooks/pre-commit', '#!/bin/sh\ntest -f "$(git rev-parse --git-dir)/MERGE_HEAD" && { echo "no merge commits here" >&2; exit 1; }\nexit 0\n');
fs.chmodSync(path.join(REPO, '.git/hooks/pre-commit'), 0o755);
const head8 = g(['rev-parse', 'HEAD']);
has(orch(['finish', 'SB-8', '--approved-by', 'the maintainer'], { code: 2 }), /merge commit was refused.*Merge aborted/, 'hook refusal aborts the merge');
assert.equal(g(['rev-parse', 'HEAD']), head8, 'develop untouched after the hook');
assert.ok(!fs.existsSync(path.join(REPO, '.git/MERGE_HEAD')), 'no merge left half done after the hook');
assert.ok(!fs.existsSync(path.join(REPO, 'src/c/c.mjs')), 'no merged file left after the hook');
fs.rmSync(path.join(REPO, '.git/hooks/pre-commit'));
has(orch(['finish', 'SB-8', '--approved-by', 'the maintainer']), /merged SB-8/, 'finish again once the hook allows it');

assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-8/logs/merge-harness-e2e.log')), 'base not moved: the gated harness is not run twice');

// ---------------------------------------------------------------- harnesses and the test rule
has(read('.orchestrate/runs/SB-2/gate-r2.txt'), /PASS {2}harness e2e \(full\): node scripts\/fake-e2e\.mjs/, 'the gate ran the harness on a covered change');
has(read('.orchestrate/runs/SB-2/gate-r2.txt'), /WARN {2}tests: 1 source file\(s\) changed and no test file \(src\/a\/greet\.mjs\)/, 'test rule warns by default');
has(read('.orchestrate/runs/SB-2/prompts/worker-r0.md'), /the gate runs the whole suite \(`node scripts\/fake-e2e\.mjs`\)[^\n]*Do not run the whole suite yourself, even if the project notes/, 'the worker runs only focused specs, over the project notes');
has(read('.orchestrate/runs/SB-2/prompts/worker-r0.md'), /the Tests section wins/, 'the Tests section has precedence');
has(read('.orchestrate/runs/SB-2/prompts/checker-r2-a.md'), /The gate already ran these on this exact tree[^\n]*`node scripts\/fake-e2e\.mjs` \(whole suite\)/, 'the checker is told what the gate ran');
has(read('.orchestrate/runs/SB-2/prompts/checker-r2-a.md'), /Do not run the whole e2e suite again/, 'the checker does not rerun the suite');
has(read('.orchestrate/runs/SB-2/prompts/checker-r2-a.md'), /fails without the change/, 'the checker checks the test catches the bug');

orch(['config', '--set', 'tests.rule=fail']); orch(['config', '--confirm']);
write('backlog/tasks/sb-9 - Page-e.md', task({ id: 'SB-9', title: 'Page e', owned: ['src/e/**'], ordinal: 9000 }));
write('backlog/tasks/sb-10 - Rename.md', task({ id: 'SB-10', title: 'Rename f', owned: ['src/f/f.mjs'], ordinal: 9500 }).replace('priority:', "no_tests: 'a pure rename, covered by e2e'\npriority:"));
write('backlog/tasks/sb-11 - Narrow.md', task({ id: 'SB-11', title: 'Narrow', owned: ['scripts/tool.mjs'], ordinal: 9600 }));
write('backlog/tasks/sb-12 - Later.md', task({ id: 'SB-12', title: 'Later', deps: '[SB-98]', owned: ['scripts/other.mjs'], ordinal: 9700 }));
g(['add', 'backlog']); g(['commit', '-q', '-m', 'SB-9..12']);
o = orch(['next', '--all']);
has(o, /^SB-11 {2}Narrow\n {2}advice: owns no test file, so the worker cannot add a test.*\n {2}advice: nothing but the project checks verifies it/m, 'advice: no test file owned, nothing verifies it');
has(o, /not SB-12: dependency SB-98 not found\n {4}advice: owns no test file/, 'advice also for tasks that cannot start yet');
assert.ok(!/^SB-10 .*\n {2}advice: owns no test/m.test(o), 'no_tests silences the advice');

orch(['start', 'SB-9']);
const WT9 = path.resolve(REPO, '../.worktrees/orch-SB-9');
write('src/e/e.mjs', "export const e = 'BROKEN';\n", WT9);
write('.orchestrate/runs/SB-9/inbox/worker.md', 'Changed: e.mjs\n');
orch(['record', 'SB-9', 'worker']);
fs.mkdirSync(path.join(REPO, '.orchestrate/harness.lock')); fs.writeFileSync(path.join(REPO, '.orchestrate/harness.lock/pid'), '999999');
o = orch(['gate', 'SB-9'], { code: 2 });
has(o, /FAIL {2}tests: 1 source file\(s\) changed and no test file \(src\/e\/e\.mjs\)/, 'test rule fail mode');
has(o, /SKIP {2}harness e2e: not run, the gate already fails above/, 'a failing test rule skips the harness');
assert.ok(fs.existsSync(path.join(REPO, '.orchestrate/harness.lock')), 'the skipped harness did not touch the lock');
write('src/e/e.test.mjs', "import { e } from './e.mjs'; if (e !== 'fine') process.exit(1);\n", WT9);
o = orch(['gate', 'SB-9'], { code: 2 });
has(o, /FAIL {2}harness e2e \(full\): node scripts\/fake-e2e\.mjs -> exit 1 in [^:]+: .*page e is broken/, 'harness failure with its tail');
assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/harness.lock')), 'stale lock taken over and released');
assert.ok(!/changed files in the worktree/.test(o), 'the harness report folder does not count as a change');
has(read('.orchestrate/runs/SB-9/logs/gate-r0-harness-e2e.log'), /e2e: page e is broken/, 'harness log kept');
orch(['fix', 'SB-9']);
has(read('.orchestrate/runs/SB-9/prompts/fix-r1.md'), /harness e2e/, 'harness failure in the fix brief');
write('src/e/e.mjs', "export const e = 'fine';\n", WT9);
write('src/e/e.test.mjs', "import { e } from './e.mjs'; if (e !== 'fine') process.exit(1);\n", WT9);
write('.orchestrate/runs/SB-9/inbox/worker.md', 'Changed: e.mjs, e.test.mjs\n');
orch(['record', 'SB-9', 'worker']);
o = orch(['gate', 'SB-9']);
has(o, /PASS {2}tests: 1 test file\(s\) changed with 1 source file\(s\)/, 'test rule satisfied');
write(ckr('SB-9'), 'EXECUTED: node scripts/fake-e2e.mjs -> e2e: 3 passed\nVERDICT: PASS\n');
orch(['record', 'SB-9', 'checker']);
write('NOTE.md', 'develop moved\n'); g(['add', 'NOTE.md']); g(['commit', '-q', '-m', 'develop moved again']);
orch(['finish', 'SB-9', '--approved-by', 'the maintainer']);
has(read('.orchestrate/runs/SB-9/logs/merge-harness-e2e.log'), /exit 0/, 'base moved: the harness runs again on the merged result');

orch(['start', 'SB-10']);
write('src/f/f.mjs', 'export const renamed = 1;\n', path.resolve(REPO, '../.worktrees/orch-SB-10'));
write('.orchestrate/runs/SB-10/inbox/worker.md', 'Changed: f.mjs\n');
orch(['record', 'SB-10', 'worker']);
has(orch(['gate', 'SB-10']), /PASS {2}tests: none, the task says why: a pure rename, covered by e2e/, 'no_tests accepted with its reason');
has(read('.orchestrate/runs/SB-10/prompts/worker-r0.md'), /The owner says this task needs no new test: a pure rename/, 'no_tests in the brief');

// ---------------------------------------------------------------- standing merge approval
write(ckr('SB-10'), 'EXECUTED: node -e "renamed" -> 1\nVERDICT: PASS\n');
has(orch(['record', 'SB-10', 'checker']), /ask the owner for the merge ok/, 'default: an ok per task');
has(orch(['config']), /merge: the owner's ok for each task · never on main, master, production/, 'default merge policy shown');
orch(['config', '--set', 'merge.protectedBranches=["develop"]']);
has(orch(['config', '--standing-approval', 'the maintainer'], { code: 1 }), /develop is protected: no standing approval/, 'no standing approval on a protected branch');
orch(['config', '--set', 'merge.protectedBranches=["main","master","production"]']); orch(['config', '--confirm']);
o = orch(['config', '--standing-approval', 'the maintainer']);
has(o, /merge: standing approval of the maintainer since 2\d{3}-/, 'standing approval recorded');
has(o, /confirmed: yes/, 'granting it keeps the config confirmed');
has(orch(['status', 'SB-10']), /next: orch finish SB-10 \(standing merge approval of the maintainer\)/, 'next action without asking');
has(orch(['finish', 'SB-10', '--override', 'skip'], { code: 1 }), /--override .* always needs --approved-by/, 'override still needs a per-task ok');
o = orch(['finish', 'SB-10']);
has(o, /merged SB-10 into develop/, 'merged on the standing approval');
has(g(['log', '-1', '--format=%B']), /Approved by standing approval of the maintainer \(2\d{3}-/, 'the standing approval is in the merge commit');
orch(['config', '--owner-approval']);
has(orch(['config']), /merge: the owner's ok for each task/, 'standing approval revoked');
orch(['config', '--set', 'baseBranch=main', '--confirm']);
has(orch(['finish', 'SB-3'], { code: 1 }), /main is a protected branch: every merge needs --approved-by/, 'protected base needs a per-task ok');
orch(['config', '--set', 'baseBranch=develop']); orch(['config', '--confirm']);

// The open runs overview.
o = orch(['status']);
has(o, /SB-3 {2}Document greet/, 'open runs listed');
has(o, /SB-4 .*\n.*phase parked/, 'parked run listed');
assert.ok(!/SB-2 {2}/.test(o), 'merged runs hidden by default');
orch(['status', '--all', '--json']);
has(orch([], { code: 0 }), /orch finish <id> \[--approved-by <name>\]/, 'usage');
has(orch(['next'], { cwd: base, code: 1 }), /not inside a git repository/, 'outside a repo');

console.log(`e2e: ${steps} checks passed in ${REPO}`);
