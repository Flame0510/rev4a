// End to end for lean checks and artifact cleanup: a slow check as a harness with paths (kind "check") skipped and
// said so, per-harness last-green markers, the task-branch commit made from the gated tree (worktree hooks cannot
// change it), merge.recheck "if-changed" (identical tree, inert base moves, a config change, a real base move, "merge"
// harnesses always), a commit hook that changes the merge, and the cleanup of command scopes (merged runs, earlier
// rounds, unowned ones only on request). Commands count their runs in a log. node test/e2e-lean.mjs [dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lean-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
const COUNT = path.join(base, 'count.log');
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base } });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const hasNot = (t, re, label) => { assert.doesNotMatch(t, re, label); n++; };
const runs = name => (fs.existsSync(COUNT) ? fs.readFileSync(COUNT, 'utf8').split('\n') : []).filter(l => l === name).length;
const state = id => JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8'));
const W = id => path.resolve(REPO, `../.worktrees/orch-${id}`);
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${state(id).round}-a.md`;
const card = (id, owned) => `---\nid: ${id}\ntitle: Card ${id}\nstatus: To Do\ndependencies: []\nmodified_files:\n  - ${owned}\npriority: medium\n---\n`;
const ARTS = () => {
  const dir = path.join(base, '.orchestrate-artifacts');
  const proj = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : null;
  return proj ? path.join(dir, proj) : null;
};
const scopes = () => (ARTS() ? fs.readdirSync(ARTS()).filter(x => x.startsWith('command-')) : [])
  .map(x => ({ x, r: JSON.parse(fs.readFileSync(path.join(ARTS(), x, 'receipt.json'), 'utf8')) }));

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', JSON.stringify({ type: 'module' }));
// Every command logs its name; it fails while app/broken exists in its checkout.
write('scripts/count.mjs', `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(COUNT)}, process.argv[2] + '\\n');\nif (fs.existsSync('app/broken')) { console.log('broken'); process.exit(1); }\n`);
for (const [id, f] of [['SB-1', 'app/a.mjs'], ['SB-2', 'app/b.mjs'], ['SB-3', 'app/c.mjs'], ['SB-4', 'app/d.mjs'], ['SB-5', 'app/e.mjs'], ['SB-6', 'app/**']]) {
  write(f.replace('**', 'f.mjs'), '// x\n'); write(`backlog/tasks/${id.toLowerCase()} - Card.md`, card(id, f));
}
write('locales/en.json', '{}\n');
write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
g('add', '-A'); g('commit', '-q', '-m', 'p');
const cfg = {
  confirmed: true, baseBranch: 'develop', links: [], checks: ['node scripts/count.mjs check'], tests: { rule: 'off' },
  harnesses: [
    { name: 'e2e', command: 'node scripts/count.mjs e2e', paths: ['app/**'], when: 'gate', timeoutSec: 60 },
    { name: 'i18n', kind: 'check', command: 'node scripts/count.mjs i18n', paths: ['locales/**'], when: 'gate', timeoutSec: 60 },
    { name: 'post', command: 'node scripts/count.mjs post', paths: ['app/**'], when: 'merge', timeoutSec: 60 },
  ],
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'], recheck: 'if-changed' },
  roles: { worker: 'w', checker: 'c' },
  artifacts: { enabled: true, minFreeBytes: 0, disposable: [], keepDays: 14 },
};
write('.orchestrate/config.json', JSON.stringify(cfg));
const work = (id, file, text = '// changed\n') => {
  orch(['start', id]);
  write(file, text, W(id));
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n'); orch(['record', id, 'worker']);
};
const pass = id => { write(ckr(id), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', id, 'checker']); };

// 1. A scoped check the card does not reach is skipped and said so; per-harness markers; briefs know it.
work('SB-1', 'app/a.mjs');
let o = orch(['gate', 'SB-1']);
has(o, /SKIP {2}harness i18n: no changed file under its paths \(locales\/\*\*\)/, 'skipped scoped check is reported');
has(o, /PASS {2}harness e2e \(full\)/, 'e2e ran');
assert.equal(runs('i18n'), 0); assert.equal(runs('e2e'), 1); assert.equal(runs('check'), 1); n += 3;
assert.deepEqual(state('SB-1').gate.harnessRuns.map(x => x.name), ['e2e'], 'a skipped harness is not in harnessRuns'); n++;
assert.ok(typeof state('SB-1').gate.harnessRuns[0].ms === 'number', 'harness duration recorded'); n++;
assert.ok(state('SB-1').gate.cfgHash, 'config fingerprint recorded'); n++;
assert.ok(fs.existsSync(path.join(REPO, '.orchestrate/runs/_suite-e2e.json')) && fs.existsSync(path.join(REPO, '.orchestrate/runs/_suite.json'))); n++;
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-1/prompts/checker-r0-a.md'), 'utf8'), /Not run at the gate \(the change does not reach their paths\): i18n\./, 'checker brief names the skipped check');
assert.ok(scopes().some(s => s.r.run === 'SB-1 r0'), 'gate scopes carry their run'); n++;
const runTmp = id => path.join(ARTS(), `run-${id}`, 'tmp');
for (const brief of ['worker-r0.md', 'checker-r0-a.md']) {
  const text = fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-1/prompts', brief), 'utf8');
  const given = text.match(/export TMPDIR='([^']+)' TMP='\1' TEMP='\1';/)?.[1];
  assert.ok(given && fs.realpathSync(given) === fs.realpathSync(runTmp('SB-1')), `${brief} assigns the run's temporary folder`); n++;
}
assert.ok(fs.statSync(runTmp('SB-1')).isDirectory(), 'the run temporary folder exists'); n++;
write('leftover/big.bin', 'x'.repeat(1000), runTmp('SB-1'));

// 2. The task-branch commit is the gated tree: a worktree pre-commit hook cannot block or change it. Identical merged
// tree: checks and gate harnesses not repeated, the "merge" harness runs; the run's scopes are deleted.
write('.git/hooks/pre-commit', `#!/bin/sh\ncase "$(pwd)" in */.worktrees/*) echo hook-refuses; exit 1;; esac\nexit 0\n`);
fs.chmodSync(path.join(REPO, '.git/hooks/pre-commit'), 0o755);
pass('SB-1');
o = orch(['finish', 'SB-1']);
has(o, /the merged tree is the gated one.*checks and gate harnesses not repeated/, 'identical tree: not repeated');
assert.equal(runs('check'), 1); assert.equal(runs('e2e'), 1); assert.equal(runs('post'), 1); n += 3;
assert.equal(g('show', 'develop:app/a.mjs'), '// changed', 'the gated change is merged'); n++;
assert.ok(!scopes().some(s => s.r.run?.startsWith('SB-1 ') || s.r.cwd === W('SB-1')), 'scopes of the merged run deleted'); n++;
has(o, /artifacts: \d+ scope\(s\) of SB-1 deleted/, 'finish reports the cleanup');
assert.ok(!fs.existsSync(path.join(ARTS(), 'run-SB-1')), 'the merged run temporary folder deleted'); n++;
fs.rmSync(path.join(REPO, '.git/hooks/pre-commit'));

// 3. The base moved only in inert files (the tracker): still not repeated.
work('SB-2', 'app/b.mjs');
orch(['gate', 'SB-2']); pass('SB-2');
const before = runs('check');
write('backlog/notes.md', 'board\n'); g('add', 'backlog/notes.md'); g('commit', '-q', '-m', 'board: notes');
has(orch(['finish', 'SB-2']), /not repeated/, 'inert base move: not repeated');
assert.equal(runs('check'), before); n++;

// 4. The config changed between gate and finish: the checks run again.
work('SB-3', 'app/c.mjs');
orch(['gate', 'SB-3']); pass('SB-3');
write('.orchestrate/config.json', JSON.stringify({ ...cfg, harnesses: cfg.harnesses.map(h => (h.name === 'e2e' ? { ...h, timeoutSec: 61 } : h)) }));
hasNot(orch(['finish', 'SB-3']), /not repeated/, 'config changed: rechecked');
assert.equal(runs('check'), before + 2); n++; // SB-3's gate and its merge
write('.orchestrate/config.json', JSON.stringify(cfg));

// 5. A real base move: checks and the gate harnesses run again on the merged result.
work('SB-4', 'app/d.mjs');
orch(['gate', 'SB-4']); pass('SB-4');
const e2eBefore = runs('e2e');
write('app/z.mjs', '// someone\n'); g('add', 'app/z.mjs'); g('commit', '-q', '-m', 'outside change');
hasNot(orch(['finish', 'SB-4']), /not repeated/, 'real base move: rechecked');
assert.equal(runs('e2e'), e2eBefore + 1); n++;

// 6. A commit hook that changes the merge commit: recorded as an untested merge (queue blocked), history untouched.
work('SB-5', 'app/e.mjs');
orch(['gate', 'SB-5']); pass('SB-5');
write('.git/hooks/pre-commit', '#!/bin/sh\nif [ -f .git/MERGE_HEAD ]; then echo "// hooked" >> app/e.mjs; git add app/e.mjs; fi\nexit 0\n');
fs.chmodSync(path.join(REPO, '.git/hooks/pre-commit'), 0o755);
has(orch(['finish', 'SB-5']), /a commit hook changed the merge/, 'hook-changed merge reported');
fs.rmSync(path.join(REPO, '.git/hooks/pre-commit'));
assert.equal(state('SB-5').untestedMerge, true); n++;
orch(['next'], 2); // the queue is blocked until someone checks it
orch(['resolve', 'SB-5', '--checked', 'checks on develop']);

// 7. Rounds: a fix keeps the scopes of the last two rounds and deletes older ones.
work('SB-6', 'app/broken', 'x\n');
orch(['gate', 'SB-6'], 2); orch(['fix', 'SB-6']);
write('.orchestrate/runs/SB-6/inbox/worker.md', 'again\n'); orch(['record', 'SB-6', 'worker']);
orch(['gate', 'SB-6'], 2); orch(['fix', 'SB-6']);
assert.ok(!scopes().some(s => s.r.run === 'SB-6 r0'), 'round 0 scopes deleted at round 2'); n++;
assert.ok(scopes().some(s => s.r.run === 'SB-6 r1'), 'round 1 scopes kept (the last failed round)'); n++;
assert.ok(fs.existsSync(runTmp('SB-6')), 'an open run keeps its temporary folder at every round'); n++;
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-6/prompts/fix-r2.md'), 'utf8'), /export TMPDIR=.*run-SB-6\/tmp/, 'the fix brief assigns it too');

// 8. A scope no run owns (an older release) is listed, never deleted by the cleanup, only on request.
const old = path.join(ARTS(), 'command-legacy');
fs.mkdirSync(path.join(old, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(old, 'receipt.json'), JSON.stringify({ version: 1, ownerPid: 999999, cwd: REPO, status: 'retained', finishedAt: '2026-10-01T00:00:00Z' }));
// An older release's receipt (no run field) in a merged run's worktree, and an interrupted command of a merged run:
// never deleted by the cleanup (no ownership proof / needs a diagnosis), only on request.
const legacyWt = path.join(ARTS(), 'command-legacy-wt');
fs.mkdirSync(path.join(legacyWt, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(legacyWt, 'receipt.json'), JSON.stringify({ version: 1, ownerPid: 999999, cwd: W('SB-1'), status: 'complete', finishedAt: '2026-10-01T00:00:00Z' }));
const crashed = path.join(ARTS(), 'command-crashed');
fs.mkdirSync(path.join(crashed, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(crashed, 'receipt.json'), JSON.stringify({ version: 1, ownerPid: 999999, cwd: W('SB-1'), run: 'SB-1 r0', status: 'running', startedAt: new Date().toISOString() }));
orch(['artifacts', 'gc']);
assert.ok(fs.existsSync(legacyWt) && fs.existsSync(crashed), 'legacy and interrupted scopes kept by the cleanup'); n++;
has(orch(['artifacts']), /unowned +3 /, 'unowned scopes listed');
orch(['artifacts', 'gc']);
assert.ok(fs.existsSync(old), 'unowned scope kept by gc'); n++;
has(orch(['artifacts', 'gc', '--unowned']), /deleted [1-9]\d* scope\(s\)/, 'deleted on request');
assert.ok(!fs.existsSync(old)); n++;
// The temporary folder of a run nobody has any more (its state is gone) is unowned: kept, deleted only on request.
write('x', 'x', path.join(ARTS(), 'run-SB-99', 'tmp'));
orch(['artifacts', 'gc']);
assert.ok(fs.existsSync(path.join(ARTS(), 'run-SB-99')), 'an unknown run temporary folder kept'); n++;
orch(['artifacts', 'gc', '--unowned']);
assert.ok(!fs.existsSync(path.join(ARTS(), 'run-SB-99')) && fs.existsSync(runTmp('SB-6')), 'deleted on request; the open run keeps its own'); n++;

// 8b. The opt-in system temp backstop: previewed by orch artifacts, applied by gc, logged (Linux only; elsewhere nothing).
const SYSTMP = path.join(base, 'systmp');
write('old-test-dir/f.txt', 'x'.repeat(2000), SYSTMP); write('.hidden/f', 'x', SYSTMP);
const saved = fs.readFileSync(path.join(REPO, '.orchestrate/config.json'), 'utf8');
write('.orchestrate/config.json', JSON.stringify({ ...JSON.parse(saved), artifacts: { ...cfg.artifacts, tmpSweep: { days: 2, dir: SYSTMP } } }));
const later = { ...process.env, ORCH_NOW: String(Date.now() + 3 * 86_400_000) };
const orchAt = args => { const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: later }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
if (process.platform === 'linux') {
  has(orchAt(['artifacts']), /temporary folder .*systmp \(artifacts\.tmpSweep\): 1 unused entry older than 2 day/, 'sweep previewed');
  assert.ok(fs.existsSync(path.join(SYSTMP, 'old-test-dir')), 'preview deletes nothing'); n++;
  has(orchAt(['artifacts', 'gc']), /temporary folder .*: deleted 1 entry older than 2 day/, 'gc applies the sweep');
  assert.ok(!fs.existsSync(path.join(SYSTMP, 'old-test-dir')) && fs.existsSync(path.join(SYSTMP, '.hidden')), 'old entry gone, hidden kept'); n++;
  has(fs.readFileSync(path.join(REPO, '.orchestrate/housekeeping.log'), 'utf8'), /deleted 1 temporary entry, [\d.]+ GB: old-test-dir/, 'deletion logged');
} else {
  has(orchAt(['artifacts', 'gc']), /deleted 0 entries/, 'no sweep off Linux');
  assert.ok(fs.existsSync(path.join(SYSTMP, 'old-test-dir'))); n++;
}
write('.orchestrate/config.json', saved);

// 10. A card given the files it needed (card normalise, here: its file edited) gets one round that does not count.
write('backlog/tasks/sb-7 - Card.md', card('SB-7', 'lib/g.mjs')); write('lib/g.mjs', '// g\n'); g('add', '-A'); g('commit', '-q', '-m', 'sb7');
orch(['start', 'SB-7']);
write('lib/g.mjs', '// changed\n', W('SB-7')); write('lib/h.mjs', '// new\n', W('SB-7'));
write('.orchestrate/runs/SB-7/inbox/worker.md', 'BLOCKED: needs lib/h.mjs\n'); orch(['record', 'SB-7', 'worker']);
has(orch(['gate', 'SB-7'], 2), /FAIL +scope: 1 file\(s\) outside the owned files: lib\/h\.mjs/, 'scope failure');
write('backlog/tasks/sb-7 - Card.md', card('SB-7', 'lib/g.mjs').replace('  - lib/g.mjs', '  - lib/g.mjs\n  - lib/h.mjs'));
o = orch(['fix', 'SB-7']);
has(o, /round 1\/3 \(files added: lib\/h\.mjs; this round does not count\)/, 'free round on a scope extension');
assert.equal(state('SB-7').scopeRounds, 1); n++;
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-7/prompts/fix-r1.md'), 'utf8'), /You may now also change: lib\/h\.mjs/, 'the fix brief names the new files');
assert.deepEqual(state('SB-7').events.at(-1), { ...state('SB-7').events.at(-1), kind: 'fix', round: 1, added: ['lib/h.mjs'], free: true }); n++;
has(orch(['status', 'SB-7']), /round 1\/3/, 'status shows the larger limit');
// A second extension is not free (once per run).
write('.orchestrate/runs/SB-7/inbox/worker.md', 'again\n'); orch(['record', 'SB-7', 'worker']);
write('lib/z.mjs', '// z\n', W('SB-7'));
orch(['gate', 'SB-7'], 2);
write('backlog/tasks/sb-7 - Card.md', card('SB-7', 'lib/g.mjs').replace('  - lib/g.mjs', '  - lib/g.mjs\n  - lib/h.mjs\n  - lib/z.mjs'));
o = orch(['fix', 'SB-7']);
has(o, /round 2\/3: /, 'a second extension counts'); hasNot(o, /does not count/, 'not free twice');
write('lib/new-file.mjs', '// n\n', W('SB-7'));
write('.orchestrate/runs/SB-7/inbox/worker.md', 'third\n'); orch(['record', 'SB-7', 'worker']);
has(orch(['gate', 'SB-7'], 2), /FAIL +scope: 1 file\(s\) outside the owned files: lib\/new-file\.mjs/, 'a later scope failure is reported as usual');

// 11. At the round limit, a gate that failed on files outside the card still gets its scope round (not the owner).
write('backlog/tasks/sb-8 - Card.md', card('SB-8', 'lib/k.mjs')); write('lib/k.mjs', '// k\n'); g('add', '-A'); g('commit', '-q', '-m', 'sb8');
orch(['start', 'SB-8']);
write('lib/k.mjs', '// changed\n', W('SB-8')); write('lib/k2.mjs', '// new\n', W('SB-8'));
for (let r = 0; r < 2; r++) {
  write('.orchestrate/runs/SB-8/inbox/worker.md', `r${r}\n`); orch(['record', 'SB-8', 'worker']); orch(['gate', 'SB-8'], 2); orch(['fix', 'SB-8']);
}
write('.orchestrate/runs/SB-8/inbox/worker.md', 'r2\n'); orch(['record', 'SB-8', 'worker']); orch(['gate', 'SB-8'], 2);
has(orch(['status', 'SB-8']), /round limit reached \(2\/2\), but the gate failed on files outside the card: .*orch card normalise SB-8/, 'at the limit: the scope path is offered');
orch(['fix', 'SB-8'], 3); // nothing added yet: still at the limit
write('backlog/tasks/sb-8 - Card.md', card('SB-8', 'lib/k.mjs').replace('  - lib/k.mjs', '  - lib/k.mjs\n  - lib/k2.mjs'));
has(orch(['fix', 'SB-8']), /round 3\/3 \(files added: lib\/k2\.mjs; this round does not count\)/, 'scope round granted at the limit');

// 12. A checker's "undo" (git checkout HEAD: HEAD is the base) wipes the change after a gate PASS: record refuses and
// names orch restore, which puts back the gated tree (pinned under refs/orch), keeps a copy, and the record then works.
write('backlog/tasks/sb-9 - Card.md', card('SB-9', 'lib/m.mjs')); write('lib/m.mjs', '// m\n'); g('add', '-A'); g('commit', '-q', '-m', 'sb9');
orch(['start', 'SB-9']);
write('lib/m.mjs', '// worked\n', W('SB-9'));
write('.orchestrate/runs/SB-9/inbox/worker.md', 'done\n'); orch(['record', 'SB-9', 'worker']);
has(orch(['gate', 'SB-9']), /GATE: PASS/, 'gate passes');
has(g('for-each-ref', '--format=%(refname)', 'refs/orch/'), /refs\/orch\/SB-9\/gate/, 'the gated tree is pinned');
const brief9 = fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-9/prompts/checker-r0-a.md'), 'utf8');
has(brief9, /Never do that inside the worktree/, 'the checker brief warns');
// Two checkers, each command in a new shell (as agents run them): own copies of the base, cleaned up by the second command.
const sh = c => spawnSync('sh', ['-c', c], { encoding: 'utf8', env: { ...process.env, TMPDIR: base } });
for (const tag of ['a']) { // the path carries the tag: checker b gets orch-base-SB-9-r0-b
  const brief = fs.readFileSync(path.join(REPO, `.orchestrate/runs/SB-9/prompts/checker-r0-${tag}.md`), 'utf8');
  const [add, remove] = [...brief.matchAll(/`(git -C [^`]+worktree (?:remove|add)[^`]+)`/g)].map(m => m[1]);
  assert.equal(sh(add).status, 0, add); n++;
  const copy = add.match(/worktree add --detach "([^"]+)"/)[1]; // the run's temp folder, written out
  has(copy, new RegExp(`run-SB-9/tmp/orch-base-SB-9-r0-${tag}$`), 'the copy is in the run temp folder');
  assert.equal(fs.readFileSync(path.join(copy, 'lib/m.mjs'), 'utf8'), '// m\n'); n++; // the base, not the change
  assert.equal(sh(add).status, 0, 'a second run replaces a copy left behind'); n++;
  assert.equal(sh(remove).status, 0, remove); n++;
  assert.ok(!fs.existsSync(copy)); n++;
}
hasNot(g('worktree', 'list'), /orch-base/, 'no copy left registered');
const wg = (...a) => spawnSync('git', a, { cwd: W('SB-9'), encoding: 'utf8' });
wg('checkout', '-q', 'HEAD', '--', 'lib/m.mjs'); write('lib/stray.mjs', '// stray\n', W('SB-9')); write('lib/new ñ.mjs', '// ñ\n', W('SB-9'));
fs.symlinkSync('m.mjs', path.join(W('SB-9'), 'lib/link.mjs'));
write(ckr('SB-9'), 'EXECUTED: x -> y\nVERDICT: PASS\n');
o = orch(['record', 'SB-9', 'checker'], 1);
has(o, /worktree changed after the gate \(4 files changed.*orch restore SB-9 puts back what the gate passed/, 'record names restore');
o = orch(['restore', 'SB-9']);
has(o, /put back what the gate passed \(4 file\(s\); what was there is in .*restored-/, 'restore reports');
assert.equal(fs.readFileSync(path.join(W('SB-9'), 'lib/m.mjs'), 'utf8'), '// worked\n'); n++;
assert.ok(!fs.existsSync(path.join(W('SB-9'), 'lib/stray.mjs'))); n++;
const aside = fs.readdirSync(path.join(REPO, '.orchestrate/runs/SB-9')).find(d => d.startsWith('restored-'));
assert.equal(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-9', aside, 'lib/stray.mjs'), 'utf8'), '// stray\n'); n++;
assert.equal(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-9', aside, 'lib/new ñ.mjs'), 'utf8'), '// ñ\n'); n++; // any file name is kept
assert.equal(fs.readlinkSync(path.join(REPO, '.orchestrate/runs/SB-9', aside, 'lib/link.mjs')), 'm.mjs'); n++;
has(orch(['restore', 'SB-9']), /already holds what the gate passed/, 'restore twice is harmless');
has(orch(['record', 'SB-9', 'checker']), /PASS/, 'the record works after the restore');
orch(['finish', 'SB-9']);
hasNot(g('for-each-ref', '--format=%(refname)', 'refs/orch/'), /SB-9/, 'the pin goes at the merge');

// 13. A round rejected only for NEEDS EVIDENCE: fix refuses, recheck runs the checker again in the same round (once).
write('backlog/tasks/sb-10 - Card.md', card('SB-10', 'lib/n.mjs')); write('lib/n.mjs', '// n\n'); g('add', '-A'); g('commit', '-q', '-m', 'sb10');
orch(['start', 'SB-10']);
write('lib/n.mjs', '// worked\n', W('SB-10'));
write('.orchestrate/runs/SB-10/inbox/worker.md', 'done\n'); orch(['record', 'SB-10', 'worker']); orch(['gate', 'SB-10']);
write(ckr('SB-10'), 'EXECUTED: started\nVERDICT: NEEDS EVIDENCE\n'); orch(['record', 'SB-10', 'checker']);
has(orch(['status', 'SB-10']), /next: orch recheck SB-10/, 'next is recheck');
has(orch(['fix', 'SB-10'], 1), /orch recheck SB-10 runs them again without using a round/, 'fix refuses');
has(orch(['recheck', 'SB-10']), /checker a of round 0 run again \(no correction round used\)[\s\S]*label "SB-10 checker a r0"/, 'recheck');
assert.equal(state('SB-10').round, 0); n++;
write(ckr('SB-10'), 'EXECUTED: tried\nVERDICT: NEEDS EVIDENCE\n'); orch(['record', 'SB-10', 'checker']);
has(orch(['status', 'SB-10']), /next: orch fix SB-10/, 'a second NEEDS EVIDENCE goes to fix');
orch(['recheck', 'SB-10'], 1);
// A second checker that reports after the round was closed: status shows it, the fix brief carries it.
write('.orchestrate/runs/SB-10/inbox/checker-r0-b.md', 'CRITICAL lib/n.mjs:1 bug B\nVERDICT: FAIL\n');
has(orch(['status', 'SB-10']), /LATE REPORT: checker b of round 0, never recorded \(FAIL\)/, 'an unrecorded report of the closed round is shown');
orch(['fix', 'SB-10']);
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-10/prompts/fix-r1.md'), 'utf8'), /Checker b of round 0 \(reported, never recorded\): FAIL[\s\S]*bug B/, 'the fix brief carries it');
write('.orchestrate/runs/SB-10/inbox/checker-r0-a.md', 'HIGH lib/n.mjs:1 still wrong\nVERDICT: FAIL\n');
has(orch(['status', 'SB-10']), /LATE REPORT: checker a of round 0, never recorded \(FAIL\).*Send its findings to the worker now/, 'late report shown');
write('.orchestrate/runs/SB-10/inbox/worker.md', 'r1\n'); orch(['record', 'SB-10', 'worker']);
write('lib/n.mjs', '// broken\n', W('SB-10')); write('lib/zz.mjs', '// out\n', W('SB-10'));
orch(['gate', 'SB-10'], 2); orch(['fix', 'SB-10']);
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-10/prompts/fix-r2.md'), 'utf8'), /Checker a of round 0 \(reported, never recorded\): FAIL[\s\S]*still wrong/, 'the fix brief carries the late report');

// 14. record --from while the sub-agent is still running (the runtime says so) is refused; unknown runtime: allowed.
write('backlog/tasks/sb-11 - Card.md', card('SB-11', 'lib/p.mjs')); write('lib/p.mjs', '// p\n'); g('add', '-A'); g('commit', '-q', '-m', 'sb11');
orch(['start', 'SB-11']);
write('lib/p.mjs', '// worked\n', W('SB-11'));
write('.orchestrate/runs/SB-11/inbox/worker.md', 'done\n'); orch(['record', 'SB-11', 'worker']); orch(['gate', 'SB-11']);
const SESS = path.join(base, 'sessions.json');
fs.writeFileSync(SESS, JSON.stringify({ sessions: [{ key: 'agent:main:coord', label: 'coord' }, { key: 'c1', label: 'SB-11 checker a r0', status: 'running', updatedAt: Date.now() }] }));
fs.writeFileSync(path.join(REPO, '.orchestrate/campaign.json'), JSON.stringify({ active: true, session: 'agent:main:coord' }));
write('placeholder.md', 'EXECUTED: nothing\nVERDICT: NEEDS EVIDENCE\n', base);
const orchS = (args, code) => { const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESS } }); assert.equal(r.status, code, r.stdout + r.stderr); n++; return r.stdout + r.stderr; };
has(orchS(['record', 'SB-11', 'checker', '--from', path.join(base, 'placeholder.md')], 1), /"SB-11 checker a r0" is still running/, '--from refused while live');
fs.writeFileSync(SESS, JSON.stringify({ sessions: [{ key: 'agent:main:coord', label: 'coord' }, { key: 'c1', label: 'SB-11 checker a r0', status: 'done', updatedAt: Date.now() }] }));
has(orchS(['record', 'SB-11', 'checker', '--from', path.join(base, 'placeholder.md')], 0), /NEEDS EVIDENCE/, '--from once it ended');
fs.rmSync(path.join(REPO, '.orchestrate/campaign.json'));

// 9. Config values are checked.
orch(['config', '--set', 'merge.recheck=sometimes'], 1);

console.log(`e2e-lean: ${n} checks passed in ${REPO}`);
