// End to end for the machine, not the code: a command the machine kills is INFRA (no verdict, no round used), the
// agent's credentials never reach checks, and a finish interrupted at any step resumes instead of failing or
// merging twice. node test/e2e-recovery.mjs [dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recovery-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
const KILL = path.join(base, 'kill-next-check');
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base, GH_TOKEN: 'gh-secret', OPENCLAW_GATEWAY_TOKEN: 'oc-secret', PROJECT_KEY: 'kept' }, // secret-ok: test fixture
  });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const state = (id) => JSON.parse(fs.readFileSync(path.join(REPO, `.orchestrate/runs/${id}/state.json`), 'utf8'));

const card = (id, owned) => `---
id: ${id}
title: Card ${id}
status: To Do
dependencies: []
modified_files:
  - ${owned}
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Card ${id}.
<!-- SECTION:DESCRIPTION:END -->
`;

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
// The project check: records which credentials it can see, and kills itself once when KILL exists (an OOM kill).
write('scripts/check.mjs', `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(base, 'check-env.json'))}, JSON.stringify({ gh: process.env.GH_TOKEN ?? null, oc: process.env.OPENCLAW_GATEWAY_TOKEN ?? null, project: process.env.PROJECT_KEY ?? null }));
if (fs.existsSync(${JSON.stringify(KILL)})) { fs.rmSync(${JSON.stringify(KILL)}); process.kill(process.pid, 'SIGKILL'); }
`);
write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node scripts/check.mjs' } }));
write('src/a.mjs', 'export const a = 1;\n'); write('src/b.mjs', 'export const b = 1;\n'); write('src/c.mjs', 'export const c = 1;\n');
write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
for (const [id, f] of [['SB-1', 'src/a.mjs'], ['SB-2', 'src/b.mjs'], ['SB-3', 'src/c.mjs']]) write(`backlog/tasks/${id.toLowerCase()} - Card.md`, card(id, f));
g('add', '-A'); g('commit', '-q', '-m', 'p');
write('.orchestrate/config.json', JSON.stringify({
  confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'], tests: { rule: 'off' },
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'] },
  roles: { worker: 'w', checker: 'c' },
}));
const WT = (id) => path.resolve(REPO, `../.worktrees/orch-${id}`);
const toReady = (id, file) => {
  orch(['start', id]);
  write(file, `export const x = '${id}';\n`, WT(id));
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n'); orch(['record', id, 'worker']);
  const o = orch(['gate', id]);
  write(ckr(id), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', id, 'checker']);
  return o;
};

// 1. The machine kills the check: INFRA, the phase stays "worked", no round is used; the next gate passes.
orch(['start', 'SB-1']);
write('src/a.mjs', "export const a = 2;\n", WT('SB-1'));
write('.orchestrate/runs/SB-1/inbox/worker.md', 'done\n'); orch(['record', 'SB-1', 'worker']);
fs.writeFileSync(KILL, '1');
let o = orch(['gate', 'SB-1'], 3);
has(o, /INFRA check 1: npm run check -> killed by SIGKILL/, 'a killed check is INFRA, not FAIL');
has(o, /GATE: INFRA \(no verdict, not a correction round\)/, 'gate result INFRA');
has(o, /next: inspect the infrastructure log .*retry orch gate SB-1 only after recovery/, 'next: inspect infra before retry');
assert.equal(state('SB-1').phase, 'worked'); assert.equal(state('SB-1').round, 0); assert.ok(!state('SB-1').gate); n += 3;
o = orch(['gate', 'SB-1']);
has(o, /GATE: PASS/, 'the rerun passes');

// 2. Checks never see the agent's credentials; the project's own variables stay.
const seen = JSON.parse(fs.readFileSync(path.join(base, 'check-env.json'), 'utf8'));
assert.deepEqual(seen, { gh: null, oc: null, project: 'kept' }); n++;

// 3. finish killed while the merge checks ran: a merge of the task branch is left in progress. The rerun aborts it
//    and merges once.
write(ckr('SB-1'), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', 'SB-1', 'checker']);
// finish had already committed the worker's change on the task branch when it was killed.
assert.equal(spawnSync('git', ['commit', '-q', '-am', 'SB-1: Card SB-1'], { cwd: WT('SB-1') }).status, 0);
g('merge', '--no-ff', '--no-commit', 'orch/SB-1');
o = orch(['finish', 'SB-1']);
has(o, /aborted a merge left in progress by an interrupted finish/, 'interrupted merge aborted');
has(o, /merged SB-1 into develop/, 'then merged');
assert.equal(g('rev-list', '--count', '--merges', 'develop'), '1'); n++;

// 4. finish killed after the merge commit, before the state was saved: the rerun records the merge, does not merge
//    again, and does the steps after it (tracker, cleanup).
toReady('SB-2', 'src/b.mjs');
assert.equal(spawnSync('git', ['commit', '-q', '-am', 'SB-2: Card SB-2'], { cwd: WT('SB-2') }).status, 0);
g('merge', '--no-ff', 'orch/SB-2', '-m', 'Merge orch/SB-2: SB-2 Card SB-2', '-m', 'Approved by Owner.');
o = orch(['finish', 'SB-2']);
has(o, /was already on develop \(an interrupted finish\): recorded it/, 'merge found and recorded');
assert.equal(g('rev-list', '--count', '--merges', 'develop'), '2'); n++;
assert.equal(state('SB-2').phase, 'merged'); assert.deepEqual(state('SB-2').finishPending, []); n += 2;
has(fs.readFileSync(path.join(REPO, 'backlog/tasks/sb-2 - Card.md'), 'utf8'), /status: Done/, 'tracker updated on recovery');
assert.ok(!fs.existsSync(WT('SB-2'))); n++;

// 5. The tracker cannot be written after the merge: the merge stays, finish says what is missing, the rerun does it.
toReady('SB-3', 'src/c.mjs');
// The board refuses the Done status while finish runs (a chmod would not stop root, which agents are).
const boardCfg = path.join(REPO, 'backlog/config.yml');
const boardText = fs.readFileSync(boardCfg, 'utf8');
fs.writeFileSync(boardCfg, boardText.replace(', "Done"', ''));
o = orch(['finish', 'SB-3']);
fs.writeFileSync(boardCfg, boardText);
has(o, /warning: the tracker was not updated .*run orch finish SB-3 again/, 'tracker failure reported');
has(o, /next: orch finish SB-3 \(to finish: tracker\)/, 'next says what is left');
assert.deepEqual(state('SB-3').finishPending, ['tracker']); n++;
o = orch(['finish', 'SB-3']);
has(o, /resumed an interrupted finish/, 'resume');
has(o, /next: orch next/, 'done');
assert.equal(g('rev-list', '--count', '--merges', 'develop'), '3'); n++;
orch(['finish', 'SB-3'], 1); // now really finished: refused

// 6. Network git commands keep the user's own ssh command (core.sshCommand, GIT_SSH, GIT_SSH_COMMAND): only without one
//    do they get orch's ssh options.
const { git: gitCall } = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'util.mjs'));
const sshLog = path.join(base, 'ssh-used.log');
const sshScript = path.join(base, 'my-ssh.sh');
fs.writeFileSync(sshScript, `#!/bin/sh\necho "custom ssh: $*" >> ${sshLog}\nexit 1\n`, { mode: 0o755 });
g('config', 'core.sshCommand', sshScript);
delete process.env.GIT_SSH; delete process.env.GIT_SSH_COMMAND; // the developer's own would win over core.sshCommand
gitCall(['ls-remote', 'git@example.invalid:x/y.git'], REPO, { allowFail: true });
assert.match(fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8') : '', /custom ssh: .*example\.invalid/, 'core.sshCommand is used'); n++;
g('config', '--unset', 'core.sshCommand');

console.log(`e2e-recovery: ${n} checks passed in ${REPO}`);
