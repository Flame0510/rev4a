// End to end for orch card: cards are created, split, checked and normalised in the skill's format, refused when
// the loop could not work them, and a real Backlog.md card keeps every line the skill does not own.
// node test/e2e-card.mjs [dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-card-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base } });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const json = (name, v) => { const f = path.join(base, `${name}.json`); fs.writeFileSync(f, JSON.stringify(v)); return f; };
const taskFiles = () => fs.readdirSync(path.join(REPO, 'backlog/tasks')).sort();

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node -e 0' } }));
for (const f of ['app/menu/page.tsx', 'app/menu/list.tsx', 'app/orders/page.tsx', 'lib/i18n/index.ts', 'db/migrations/001.sql', 'docs/guide.md']) write(f, '// x\n');
for (const f of ['tests/e2e/01-menu.spec.ts', 'tests/i18n/menu.test.ts']) write(f, '// t\n');
write('backlog/config.yml', 'project_name: "P"\nstatuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
// A real tourguide card (SB-62.7, trimmed): Backlog.md fields the skill does not own, ISO dates, notes, final summary.
write('backlog/tasks/sb-62 - Localize-safe-errors.md', `---
id: SB-62
title: 'Localize safe errors and centralize presentation'
status: In Progress
assignee: []
created_date: '2026-10-20T10:00:00Z'
labels: []
dependencies: []
modified_files:
  - lib/i18n/index.ts
  - tests/i18n/menu.test.ts
priority: high
type: enhancement
project: foundation
ordinal: 899000000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent card for localized presentation of errors, dates, money and numbers across the app.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every residual error surface shows a safe EN/IT catalog message.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- 2026-10-26 18:50 orch: started
<!-- SECTION:NOTES:END -->
`);
// An old free-text card: no acceptance criteria, no owned files, no kind.
write('backlog/tasks/sb-70 - Old-card.md', `---
id: SB-70
title: Fix the orders page
status: To Do
assignee: []
created_date: '2026-10-21T09:00:00Z'
labels:
  - legacy
dependencies: []
priority: medium
type: bug
ordinal: 899100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The orders page shows the wrong total when a line is removed.
<!-- SECTION:DESCRIPTION:END -->
`);
g('add', '-A'); g('commit', '-q', '-m', 'p');
write('.orchestrate/config.json', JSON.stringify({
  confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'], tests: { rule: 'warn' },
  risk: { paths: ['db/**'] }, external: { flows: { 'image-generation': {} } },
  merge: { approval: 'owner', standing: null, protectedBranches: ['main'] }, roles: { worker: 'w', checker: 'c' },
}));

const good = {
  title: 'Menu: show prices in the venue currency',
  goal: 'Menu prices use the venue currency formatter instead of a hard-coded euro sign, so venues abroad read their own currency.',
  acceptance: ['The menu list shows prices formatted with the venue currency in EN and IT.', 'A unit test covers EUR and GBP venues and fails on the old formatter.'],
  owned: ['app/menu/list.tsx', 'tests/i18n/menu.test.ts', 'tests/e2e/01-menu.spec.ts'],
  kind: 'code', dependencies: ['SB-62'], external: ['image-generation'], priority: 'high', labels: ['i18n'],
};

// 1. A valid card: created with the next number, in Backlog.md's format, and the loop can pick it.
let before = taskFiles();
let o = orch(['card', 'new', '--from', json('good', good), '--dry-run']);
has(o, /valid: 1 card\(s\), nothing written \(--dry-run\)/, 'dry run');
assert.deepEqual(taskFiles(), before); n++;
o = orch(['card', 'new', '--from', json('good', good)]);
has(o, /created SB-71: .*sb-71 - Menu-show-prices-in-the-venue-currency\.md/, 'next free number after SB-70');
const made = read('backlog/tasks/sb-71 - Menu-show-prices-in-the-venue-currency.md');
has(made, /^---\nid: SB-71\ntitle: 'Menu: show prices in the venue currency'\nstatus: To Do\nassignee: \[\]\ncreated_date: '\d{4}-\d\d-\d\dT\d\d:\d\d:00Z'\n/, 'front matter head, ISO date like the project');
has(made, /labels:\n {2}- i18n\ndependencies:\n {2}- SB-62\nmodified_files:\n {2}- app\/menu\/list\.tsx\n {2}- tests\/i18n\/menu\.test\.ts\n {2}- tests\/e2e\/01-menu\.spec\.ts\npriority: high\nkind: code\nexternal_flows:\n {2}- image-generation\nordinal: 899101000\n---/, 'card fields in order');
has(made, /<!-- AC:BEGIN -->\n- \[ \] #1 The menu list shows prices.*\n- \[ \] #2 A unit test covers EUR and GBP.*\n<!-- AC:END -->/, 'numbered acceptance criteria');
o = orch(['card', 'check', 'SB-71']);
has(o, /SB-71: ok/, 'a created card passes its own check');

// 2. Refused cards: nothing is written, every problem is listed.
before = taskFiles();
o = orch(['card', 'new', '--from', json('bad', { title: 'x', goal: 'short', acceptance: ['ok'], owned: ['**'], kind: 'feature', dependencies: ['SB-99'] })], 2);
has(o, /ERROR .*goal is missing or too short/, 'short goal');
has(o, /ERROR .*acceptance #1 "ok" is too vague/, 'vague criterion');
has(o, /ERROR .*owned "\*\*" is the whole repository/, 'whole repository');
has(o, /ERROR .*kind "feature" is not one of code, test, content, migration/, 'bad kind');
has(o, /ERROR .*dependency SB-99 does not exist/, 'missing dependency');
has(o, /nothing written: \d+ error\(s\)/, 'nothing written');
o = orch(['card', 'new', '--from', json('notest', { ...good, owned: ['app/menu/list.tsx'] })], 2);
has(o, /ERROR .*a code card must own a test file .* or give noTests: <why>/, 'code card without a test');
o = orch(['card', 'new', '--from', json('typo', { ...good, acceptence: ['x'] })], 1);
has(o, /unknown card field\(s\): acceptence/, 'a typo is not silently dropped');
assert.deepEqual(taskFiles(), before); n++;
o = orch(['card', 'new', '--from', json('mig', { ...good, title: 'Add a column', kind: 'migration', owned: ['lib/i18n/index.ts', 'tests/i18n/menu.test.ts'], external: ['unknown-flow'] }), '--dry-run']);
has(o, /WARN .*a migration card that owns nothing under risk\.paths/, 'migration without a migration file');
has(o, /WARN .*external flow "unknown-flow" is not declared/, 'unknown external flow');

// 3. Split: all children are validated first, created as <parent>.<n>, overlaps are reported.
const child = (title, owned) => ({ ...good, title, owned, dependencies: [] });
o = orch(['card', 'split', 'SB-62', '--from', json('split-bad', [child('Errors in the staff views', ['app/orders/page.tsx', 'tests/i18n/menu.test.ts']), { title: 'broken' }])], 2);
has(o, /nothing written/, 'one bad child: nothing written');
o = orch(['card', 'split', 'SB-62', '--from', json('split', [
  child('Errors in the staff views', ['app/orders/page.tsx', 'tests/i18n/menu.test.ts']),
  child('Errors in the menu views', ['app/menu/page.tsx', 'tests/i18n/menu.test.ts']),
])]);
has(o, /WARN {2}cards 1 and 2 overlap \(tests\/i18n\/menu\.test\.ts/, 'overlap between children reported');
assert.ok(!/overlaps SB-62 \(In Progress\)/.test(o), 'children never warn about their own parent (a closure card shares their files)'); n++;
has(o, /created SB-62\.1: .*\ncreated SB-62\.2: /, 'children numbered under the parent');
o = orch(['card', 'new', '--from', json('other', { ...good, title: 'Unrelated card on the same test', dependencies: [] }), '--dry-run']);
has(o, /WARN {2}card 1 .*: overlaps SB-62 \(In Progress\) on tests\/i18n\/menu\.test\.ts: it will wait until SB-62 is done/, 'overlap with an unrelated running card reported');
has(read('backlog/tasks/sb-62.2 - Errors-in-the-menu-views.md'), /parent_task_id: SB-62\n/, 'child names its parent');

// 4. An old free-text card: check lists what it lacks; normalise shows it as JSON, then rewrites only its own fields.
o = orch(['card', 'check', 'SB-70'], 2);
has(o, /ERROR SB-70: no acceptance criteria/, 'old card: no criteria');
has(o, /ERROR SB-70: no owned files/, 'old card: no owned files');
has(o, /next: orch card normalise SB-70/, 'next: normalise');
o = orch(['card', 'normalise', 'SB-70']);
const shown = JSON.parse(o.slice(0, o.indexOf('\n}') + 2));
assert.equal(shown.title, 'Fix the orders page'); assert.deepEqual(shown.labels, ['legacy']); assert.equal(shown.kind, 'code'); n += 3;
const fixed = { ...shown, acceptance: ['Removing a line updates the order total immediately.', 'A unit test removes a line and checks the total.'], owned: ['app/orders/page.tsx', 'tests/orders/total.test.ts'] };
o = orch(['card', 'normalise', 'SB-70', '--from', json('fixed', fixed)]);
has(o, /WARN {2}SB-70: owned file\(s\) not in the repository yet .*tests\/orders\/total\.test\.ts/, 'new test file noted');
has(o, /updated SB-70 in the card format/, 'normalised');
const norm = read('backlog/tasks/sb-70 - Old-card.md');
has(norm, /^---\nid: SB-70\ntitle: Fix the orders page\nstatus: To Do\nassignee: \[\]\ncreated_date: '2026-10-21T09:00:00Z'\nupdated_date: '\d{4}-[^']+'\nlabels:\n {2}- legacy\ndependencies: \[\]\npriority: medium\ntype: bug\nmodified_files:\n {2}- app\/orders\/page\.tsx\n {2}- tests\/orders\/total\.test\.ts\nkind: code\nordinal: 899100000\n---/, 'own fields rewritten, type/assignee/ordinal kept');
has(norm, /<!-- SECTION:DESCRIPTION:BEGIN -->\nThe orders page shows the wrong total when a line is removed\.\n<!-- SECTION:DESCRIPTION:END -->/, 'description kept');
has(norm, /<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- \[ \] #1 Removing a line/, 'acceptance section added after the description, as Backlog.md writes it');
o = orch(['card', 'check', 'SB-70']);
has(o, /SB-70: ok/, 'normalised card passes');

// 5. The real tourguide card is read without loss; normalise keeps its notes and Backlog.md fields.
o = orch(['card', 'check', 'SB-62']);
has(o, /SB-62: ok/, 'real card reads and validates');
const sb62 = JSON.parse(orch(['card', 'normalise', 'SB-62']).split('\n}')[0] + '\n}');
assert.deepEqual(sb62.acceptance, ['Every residual error surface shows a safe EN/IT catalog message.']); n++;
orch(['card', 'normalise', 'SB-62', '--from', json('sb62', sb62)]);
const after62 = read('backlog/tasks/sb-62 - Localize-safe-errors.md');
has(after62, /type: enhancement\nproject: foundation\n/, 'unknown Backlog.md fields kept');
has(after62, /<!-- SECTION:NOTES:BEGIN -->\n- 2026-10-26 18:50 orch: started\n<!-- SECTION:NOTES:END -->/, 'notes kept');
has(after62, /status: In Progress\n/, 'status untouched');

// 6. A created card goes through the loop: next lists it, start makes its worktree.
o = orch(['next', '--all']);
has(o, /SB-70 {2}Fix the orders page/, 'normalised card is eligible');
g('add', '-A'); g('commit', '-q', '-m', 'cards');
o = orch(['start', 'SB-70']);
has(o, /worktree/, 'start works on a card made by orch card');

// 7. Findings of the first checker (round 1).
const yaml = (await import('node:module')).createRequire(import.meta.url);
const fm = rel => read(rel).split('\n---')[0];
// H2: titles and labels YAML would misread are quoted.
o = orch(['card', 'new', '--from', json('yaml', { ...good, title: '- leading dash', labels: ['- x', '12', 'yes'], dependencies: [] })]);
const yfile = o.match(/created (SB-\d+): (.*)$/m);
const ytext = fm(path.relative(REPO, yfile[2]));
has(ytext, /\ntitle: '- leading dash'\n/, 'leading dash quoted');
has(ytext, /labels:\n {2}- '- x'\n {2}- '12'\n {2}- 'yes'\n/, 'list items quoted');
o = orch(['card', 'new', '--from', json('num', { ...good, title: '123', dependencies: [] }), '--dry-run']);
has(o, /valid: 1 card/, 'numeric title accepted');
// L1/M3: wrong types and line breaks are refused, never coerced.
o = orch(['card', 'new', '--from', json('types', { ...good, title: { a: 1 }, acceptance: 'one string', checks: ['line1\nline2: x'] })], 1);
has(o, /title must be a string; acceptance must be a list of strings; checks\[0\] has a line break/, 'types refused');
// L2: Windows paths refused.
o = orch(['card', 'new', '--from', json('win', { ...good, owned: ['app\\menu\\list.tsx', 'tests/i18n/menu.test.ts'] })], 2);
has(o, /must use forward slashes/, 'backslash path refused');
// H3: kind inferred from what a glob covers.
write('backlog/tasks/sb-90 - Folder-card.md', '---\nid: SB-90\ntitle: Folder card\nstatus: To Do\ndependencies: []\nmodified_files:\n  - app/**\npriority: low\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nA card that owns a whole folder of the app code.\n<!-- SECTION:DESCRIPTION:END -->\n');
has(orch(['card', 'normalise', 'SB-90']), /"kind": "code"/, 'app/** is code, not test');
write('backlog/tasks/sb-91 - Docs-card.md', '---\nid: SB-91\ntitle: Docs card\nstatus: To Do\ndependencies: []\nmodified_files:\n  - docs/**\npriority: low\n---\n');
has(orch(['card', 'normalise', 'SB-91']), /"kind": "content"/, 'docs/** is content');
write('backlog/tasks/sb-92 - Migration-card.md', '---\nid: SB-92\ntitle: Migration card\nstatus: To Do\ndependencies: []\nmodified_files:\n  - db/migrations/*.sql\npriority: low\n---\n');
has(orch(['card', 'normalise', 'SB-92']), /"kind": "migration"/, 'migrations folder is migration');
// H1: a split is all or none, even when a later file collides.
// A stray file without an id has the name the second child would get (SB-62.3 is next, then SB-62.4).
write('backlog/tasks/sb-62.4 - Fourth-child.md', 'notes without front matter\n');
before = taskFiles();
o = orch(['card', 'split', 'SB-62', '--from', json('split-clash', [child('Third child', ['app/orders/page.tsx', 'tests/i18n/menu.test.ts']), child('Fourth child', ['app/menu/page.tsx', 'tests/i18n/menu.test.ts'])])], 1);
has(o, /already exists: nothing written/, 'collision refused');
assert.deepEqual(taskFiles(), before); n++;
fs.rmSync(path.join(REPO, 'backlog/tasks/sb-62.4 - Fourth-child.md'));
// M1: ids in completed/ and archive/ stay taken.
write('backlog/completed/sb-120 - Old-done.md', '---\nid: SB-120\ntitle: Old done\nstatus: Done\n---\n');
o = orch(['card', 'new', '--from', json('after-archive', { ...good, title: 'After archived ids', dependencies: [] })]);
has(o, /created SB-121: /, 'numbering skips ids in completed/');
// M2/M4/M5: a hand-written CRLF card with sections without markers and a ticked criterion.
const crlfCard = ['---', 'id: SB-95', 'title: Hand written', 'status: In Progress', 'custom: keep me', 'dependencies: []', 'priority: medium', '---', '', '## Description', '', 'Old free text that explains the bug in the orders page.', '', '## Acceptance Criteria', '', '- [x] Totals update when a line is removed.', '- [ ] Totals update when a line is added.', '', '## Implementation Notes', '', 'Keep this note.', ''].join('\r\n');
write('backlog/tasks/sb-95 - Hand-written.md', crlfCard);
const c95 = JSON.parse(orch(['card', 'normalise', 'SB-95']).split('\n}')[0] + '\n}');
assert.deepEqual(c95.acceptance, ['Totals update when a line is removed.', 'Totals update when a line is added.']); n++;
orch(['card', 'normalise', 'SB-95', '--from', json('c95', { ...c95, owned: ['app/orders/page.tsx', 'tests/orders/total.test.ts'] })]);
const t95 = read('backlog/tasks/sb-95 - Hand-written.md');
assert.ok(!/[^\r]\n/.test(t95), 'every line keeps \\r\\n'); n++;
const u95 = t95.replace(/\r\n/g, '\n');
assert.equal((u95.match(/^## Description$/gm) ?? []).length, 1, 'one Description section'); n++;
assert.equal((u95.match(/^## Acceptance Criteria$/gm) ?? []).length, 1, 'one Acceptance Criteria section'); n++;
has(u95, /custom: keep me\n/, 'unknown key kept');
has(u95, /- \[x\] #1 Totals update when a line is removed\.\n- \[ \] #2 Totals update when a line is added\./, 'ticked criterion stays ticked');
has(u95, /## Implementation Notes\n\nKeep this note\./, 'notes kept');
has(u95, /<!-- SECTION:DESCRIPTION:BEGIN -->\nOld free text that explains the bug in the orders page\.\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->/, 'sections in order');
// M6: migration cards wait for each other; external flows reach the worker and checker briefs.
write('backlog/tasks/sb-93 - Mig-a.md', '---\nid: SB-93\ntitle: Mig A\nstatus: In Progress\ndependencies: []\nmodified_files:\n  - supabase/migrations/002.sql\nkind: migration\npriority: low\n---\n');
o = orch(['next', '--all']);
has(o, /not SB-92: migration cards run one at a time: SB-93 is In Progress/, 'migration cards serialized');
fs.rmSync(path.join(REPO, 'backlog/tasks/sb-93 - Mig-a.md'));
g('add', '-A'); g('commit', '-q', '-m', 'more cards');
orch(['start', 'SB-71', '--force']);
has(read('.orchestrate/runs/SB-71/prompts/worker-r0.md'), /touches the external flow "image-generation" \(a paid or outside service\): never call the real service, not even once/, 'worker brief: external flow rule');

// 8. Second checker round: a folder merely named "migration" is not a migration; fenced headings are text; criteria go
//    after the description markers; the checker brief carries the external-flow rule.
write('backlog/tasks/sb-96 - Route-card.md', '---\nid: SB-96\ntitle: Route card\nstatus: To Do\ndependencies: []\nmodified_files:\n  - app/migration/page.tsx\n  - tests/migration/page.test.ts\npriority: low\n---\n');
has(orch(['card', 'normalise', 'SB-96']), /"kind": "code"/, 'app/migration/** is code');
write('backlog/tasks/sb-97 - Fenced.md', ['---', 'id: SB-97', 'title: Fenced', 'status: To Do', 'dependencies: []', 'priority: low', '---', '', '## Notes', '', '```md', '## Description', 'example inside a fence', '```', '', '## Description', '', 'The real description of this hand-written card.', ''].join('\n'));
const c97 = JSON.parse(orch(['card', 'normalise', 'SB-97']).split('\n}')[0] + '\n}');
orch(['card', 'normalise', 'SB-97', '--from', json('c97', { ...c97, acceptance: ['The fenced example stays exactly as it was.'], owned: ['docs/guide.md'], kind: 'content' })]);
const t97 = read('backlog/tasks/sb-97 - Fenced.md');
has(t97, /```md\n## Description\nexample inside a fence\n```/, 'fenced block untouched');
assert.equal((t97.match(/^## Description$/gm) ?? []).length, 2, 'one real Description plus the fenced one'); n++;
write('backlog/tasks/sb-98 - Markers.md', ['---', 'id: SB-98', 'title: Markers only', 'status: To Do', 'dependencies: []', 'priority: low', '---', '', '<!-- SECTION:DESCRIPTION:BEGIN -->', 'Description with markers but no heading, kept as it is.', '<!-- SECTION:DESCRIPTION:END -->', ''].join('\n'));
const c98 = JSON.parse(orch(['card', 'normalise', 'SB-98']).split('\n}')[0] + '\n}');
orch(['card', 'normalise', 'SB-98', '--from', json('c98', { ...c98, acceptance: ['The criteria come after the description block.'], owned: ['docs/guide.md'], kind: 'content' })]);
has(read('backlog/tasks/sb-98 - Markers.md'), /<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->/, 'criteria after the description markers');
o = orch(['card', 'new', '--from', json('code-mig', { ...good, title: 'Code card with a migration', owned: ['supabase/migrations/003.sql', 'app/menu/list.tsx', 'tests/i18n/menu.test.ts'], dependencies: [] }), '--dry-run']);
has(o, /kind code, but it owns a migration \(supabase\/migrations\/003\.sql\)/, 'non-migration kind owning a migration warned');
// The checker brief: SB-71 (external flow) through the gate.
write('app/menu/list.tsx', '// changed\n', path.resolve(REPO, '../.worktrees/orch-SB-71'));
write('.orchestrate/runs/SB-71/inbox/worker.md', 'done\n'); orch(['record', 'SB-71', 'worker']);
has(orch(['gate', 'SB-71']), /GATE: PASS/, 'gate passes');
has(read('.orchestrate/runs/SB-71/prompts/checker-r0-a.md'), /touches the external flow "image-generation" \(a paid or outside service\): never call the real service\. .*a test or change that would call the real service is a FAIL/, 'checker brief: external flow rule');

console.log(`e2e-card: ${n} checks passed in ${REPO}`);
