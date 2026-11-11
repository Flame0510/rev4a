// End to end for the machine, not the code: a command the machine kills is INFRA (no verdict, no round used), the
// agent's credentials never reach checks, and a finish interrupted at any step resumes instead of failing or
// merging twice. node test/e2e-recovery.mjs [dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recovery-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
const KILL = path.join(base, 'kill-next-check');
const SESSIONS = path.join(base, 'sessions.json'); // absent means unknown; never invoke the real runtime
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const orch = (args, code = 0, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESSIONS, GH_TOKEN: 'gh-secret', OPENCLAW_GATEWAY_TOKEN: 'oc-secret', PROJECT_KEY: 'kept', ...extraEnv }, // secret-ok: test fixture
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

// 7. A stopped worker continues from its current worktree once per round, with no runtime required.
write('src/d.mjs', 'export const d = 1;\n');
write('backlog/tasks/sb-4 - Card.md', card('SB-4', 'src/d.mjs'));
g('add', 'src/d.mjs', 'backlog/tasks/sb-4 - Card.md'); g('commit', '-q', '-m', 'resume fixture');
orch(['start', 'SB-4']);
const resumeDir = path.join(REPO, '.orchestrate/runs/SB-4');
const sf = path.join(resumeDir, 'state.json');
const initial = state('SB-4');
const original = fs.readFileSync(initial.prompt, 'utf8');
const configBytes = fs.readFileSync(path.join(REPO, '.orchestrate/config.json'));
write('src/d.mjs', 'export const d = 2;\n', WT('SB-4'));
write('src/unfinished.mjs', '// partial work\n', WT('SB-4'));
orch(['campaign', 'start', '--session', 'resume-coordinator', '--scope', 'SB-4']);
const sessions = rows => fs.writeFileSync(SESSIONS, JSON.stringify({ sessions: [{ key: 'resume-coordinator' }, ...rows] }));
const worker = { key: 'worker', label: 'SB-4 worker r0', updatedAt: Date.now() };
const beforeLive = fs.readFileSync(sf);
const beforeLiveActivity = fs.readFileSync(path.join(REPO, '.orchestrate/activity'));
const beforeLiveFiles = fs.readdirSync(path.join(resumeDir, 'prompts'));
for (const status of ['running', 'queued']) {
  sessions([{ ...worker, status }]);
  has(orch(['prompt', 'SB-4', 'worker', '--resume'], 4), /the worker "SB-4 worker r0" is still running: wait for its completion, then orch record SB-4 worker/);
  assert.deepEqual(fs.readFileSync(sf), beforeLive); n++;
  assert.deepEqual(fs.readFileSync(path.join(REPO, '.orchestrate/activity')), beforeLiveActivity); n++;
  assert.deepEqual(fs.readdirSync(path.join(resumeDir, 'prompts')), beforeLiveFiles); n++;
  assert.equal(fs.readFileSync(initial.prompt, 'utf8'), original); n++;
}
console.log('ok resume guard: running/queued -> exit 4; state/activity/brief unchanged; allowance unused');
fs.rmSync(SESSIONS); // unknown runtime is allowed, even during a campaign
let resumeOut = orch(['prompt', 'SB-4', 'worker', '--resume']);
const resumeFile = resumeOut.split('\n')[0];
const resumed = state('SB-4');
const resumeBrief = fs.readFileSync(resumeFile, 'utf8');
assert.equal(resumeFile, fs.realpathSync(path.join(resumeDir, 'prompts/worker-r0-resume.md'))); n++;
assert.ok(resumeBrief.startsWith(`${original}\n\n`)); n++;
has(resumeBrief, /## A worker before you stopped without a report[\s\S]*Do not start over[\s\S]*same report/);
has(resumeBrief, /src\/d\.mjs\s+\|/); has(resumeBrief, /src\/unfinished\.mjs/);
assert.equal(resumed.prompt, resumeFile); assert.equal(resumed.round, initial.round); assert.equal(resumed.phase, 'working'); n += 3;
assert.deepEqual(resumed.events.slice(0, -1), initial.events); n++;
const { t: restartedAt, ...restart } = resumed.events.at(-1);
assert.ok(Number.isFinite(Date.parse(restartedAt))); n++;
assert.deepEqual(restart, { kind: 'restart', round: 0, role: 'worker', model: 'w' }); n++;
has(resumeOut, /next: delegate the worker.*worker-r0-resume\.md/);
assert.equal(orch(['prompt', 'SB-4', 'worker']).trim(), resumeFile); n++;
console.log('ok resume: original brief + diff stat + untracked; prompt/event/next updated without using a round');
console.log(`resume section from test run:\n${resumeBrief.slice(original.length).trim()}`);

const beforeRefusal = fs.readFileSync(sf);
const beforeActivity = fs.readFileSync(path.join(REPO, '.orchestrate/activity'));
const beforeFiles = fs.readdirSync(path.join(resumeDir, 'prompts'));
has(orch(['prompt', 'SB-4', 'worker', '--resume'], 3), /worker of round 0 stopped twice; split the card \(orch card split SB-4\) or park it \(orch park SB-4\), or ask the owner/);
assert.deepEqual(fs.readFileSync(sf), beforeRefusal); n++;
assert.deepEqual(fs.readFileSync(path.join(REPO, '.orchestrate/activity')), beforeActivity); n++;
assert.deepEqual(fs.readdirSync(path.join(resumeDir, 'prompts')), beforeFiles); n++;
assert.equal(fs.readFileSync(resumeFile, 'utf8'), resumeBrief); n++;
orch(['prompt', 'SB-4', 'checker', '--resume'], 1);
orch(['prompt', 'SB-4', 'advisor', '--resume'], 1);
console.log('ok resume: second attempt -> exit 3; state, activity, prompt bytes and file list unchanged');

// Resume prepared, coordinator interrupted before spawning: the old session cannot consume the second-stop path.
const campaignPath = path.join(REPO, '.orchestrate/campaign.json');
const preparedCampaign = fs.readFileSync(campaignPath);
const keeperAt = Date.now() + 11 * 60000;
const keeper = () => {
  fs.writeFileSync(campaignPath, preparedCampaign); // each probe begins without a previous wake's backoff
  return JSON.parse(orch(['keeper', '--json'], 0, { ORCH_NOW: String(keeperAt) }).trim().split('\n').at(-1));
};
assert.equal(keeper().action, 'wait'); n++;
console.log('ok interrupted resume: unknown runtime -> wait');
for (const [label, rows] of [
  ['empty', []],
  ['old-ended', [{ ...worker, status: 'done', updatedAt: Date.parse(restartedAt) - 1 }]],
  ['old-running', [{ ...worker, status: 'running', updatedAt: Date.parse(restartedAt) - 1 }]],
]) {
  sessions(rows);
  const d = keeper();
  assert.equal(d.action, 'wake'); n++;
  has(d.next, /^start it now: delegate the worker.*worker-r0-resume\.md/);
  assert.doesNotMatch(d.next, /--resume/); n++;
  console.log(`ok interrupted resume: ${label} -> start it now: spawn worker-r0-resume.md`);
}
has(orch(['status', 'SB-4']), /next: delegate the worker.*worker-r0-resume\.md/);
// A replacement that really did start remains guarded; if it ends, do not offer another resume in this round.
sessions([{ ...worker, status: 'running', updatedAt: Date.parse(restartedAt) }]);
has(orch(['status', 'SB-4']), /wait for its completion, do not start another/);
orch(['prompt', 'SB-4', 'worker', '--resume'], 4);
assert.deepEqual(fs.readFileSync(sf), beforeRefusal); n++;
assert.equal(keeper().action, 'wait'); n++;
sessions([{ ...worker, status: 'done', updatedAt: Date.parse(restartedAt) }]);
const stoppedAgain = keeper();
has(stoppedAgain.next, /split the card .*or park it .*or ask the owner/);
assert.doesNotMatch(stoppedAgain.next, /--resume/); n++;
console.log('ok interrupted resume: replacement running -> wait/exit 4; replacement ended -> split/park/owner, no second --resume');
fs.rmSync(SESSIONS);
fs.writeFileSync(campaignPath, preparedCampaign);

// A real checker rejection opens a correction round; its current fix brief, rather than the first brief, is preserved.
fs.rmSync(path.join(WT('SB-4'), 'src/unfinished.mjs'));
orch(['gate', 'SB-4']);
write(ckr('SB-4'), 'HIGH: unfinished change\nEXECUTED: fixture -> failed\nVERDICT: FAIL\n');
orch(['record', 'SB-4', 'checker']);
const failedBytes = fs.readFileSync(sf);
orch(['prompt', 'SB-4', 'worker', '--resume'], 1);
assert.deepEqual(fs.readFileSync(sf), failedBytes); n++;
assert.ok(!fs.existsSync(path.join(resumeDir, 'prompts/worker-r1-resume.md'))); n++;
orch(['fix', 'SB-4']);
const fix = state('SB-4');
assert.equal(fix.round, 1); n++;
const fixBrief = fs.readFileSync(fix.prompt, 'utf8');

// Include staged additions in the diff against the base; both evidence blocks stop at 60 lines.
for (let i = 0; i < 65; i++) write(`resume-fixtures/staged-${String(i).padStart(2, '0')}.txt`, 'partial\n', WT('SB-4'));
const staged = spawnSync('git', ['add', 'resume-fixtures'], { cwd: WT('SB-4'), encoding: 'utf8' });
assert.equal(staged.status, 0, staged.stderr); n++;
for (let i = 0; i < 65; i++) write(`resume-fixtures/untracked-${String(i).padStart(2, '0')}.txt`, 'unfinished\n', WT('SB-4'));
resumeOut = orch(['prompt', 'SB-4', 'worker', '--resume']);
const nextBrief = fs.readFileSync(state('SB-4').prompt, 'utf8');
assert.ok(nextBrief.startsWith(`${fixBrief}\n\n`)); n++;
const section = nextBrief.slice(fixBrief.length);
const blocks = [...section.matchAll(/```text\n([^]*?)\n```/g)].map(m => m[1].split('\n'));
assert.deepEqual(blocks.map(b => b.length), [60, 60]); n++;
has(blocks[0].join('\n'), /resume-fixtures\/staged-00\.txt/);
has(blocks[1].join('\n'), /resume-fixtures\/untracked-00\.txt/);
assert.doesNotMatch(section, /(?:staged|untracked)-64\.txt/); n++;
assert.equal(state('SB-4').round, 1); n++;
assert.equal(state('SB-4').events.filter(e => e.kind === 'restart').length, 2); n++;
has(resumeOut, /next: delegate the worker.*worker-r1-resume\.md/);
assert.deepEqual(fs.readFileSync(path.join(REPO, '.orchestrate/config.json')), configBytes); n++;
console.log('ok resume: outside working -> exit 1; after fix -> allowed; current fix brief kept; both lists capped at 60 lines; config unchanged');



// 8. Per-run exclusion, stale ownership, and concurrent resumes (no platform-specific runtime needed).
const lockModule = path.resolve(path.dirname(ORCH), 'lib/runlock.mjs');
const { withRunLock: takeRunLock, processIdentity, deadReason, sleep } = await import(lockModule);
// This test runner is deliberately not orch.mjs; model its command when testing ownership in this process.
const withRunLock = (root, id, options, action) => takeRunLock(root, id,
  { ...options, observations: { command: () => 'node orch.mjs', ...options.observations } }, action);
const lockRun = path.join(REPO, '.orchestrate/runs/LOCK-1');
const lockDir = path.join(lockRun, 'run.lock');
fs.mkdirSync(lockRun, { recursive: true });
const own = value => { fs.mkdirSync(lockDir, { recursive: true }); fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(value)); };
const stale = { pid: 2147483647, startedAt: 1000, bootId: 'old', cmd: 'dead command' };
for (const [label, owner, observations] of [
  ['dead pid', stale, {}],
  ['pid reuse', { ...stale, pid: process.pid }, { alive: () => true, start: () => 9000, boot: () => 'old', hasProc: () => true }],
  ['other boot', { ...stale, pid: process.pid }, { alive: () => true, start: () => 1000, boot: () => 'new', hasProc: () => true }],
  ['no-proc ps reuse', { ...stale, pid: process.pid, bootId: null }, { alive: () => true, hasProc: () => false, command: () => 'some-other-program' }],
]) {
  own(owner);
  assert.ok(deadReason(owner, observations));
  await withRunLock(REPO, 'LOCK-1', { cmd: 'test', waitSec: 0, observations }, () => { n++; });
  assert.ok(!fs.existsSync(lockDir)); n++;
  console.log(`ok runlock: stale ${label} taken over`);
}
const replacement = { ...processIdentity(), cmd: 'third process', token: 'replacement' };
for (const at of ['beforeReclaim', 'afterReclaim']) {
  own(stale);
  let third; let releaseThird; let enteredThird;
  const entered = new Promise(resolve => { enteredThird = resolve; });
  const release = new Promise(resolve => { releaseThird = resolve; });
  let active = 0; let maxActive = 0;
  const count = () => { active++; maxActive = Math.max(maxActive, active); };
  const replace = async () => {
    fs.rmSync(lockDir, { recursive: true }); // the stale holder is replaced before reclamation's recheck
    third = withRunLock(REPO, 'LOCK-1', { cmd: 'third process', waitSec: 0 }, async () => {
      count(); enteredThird(); await release; active--;
    });
    await entered;
  };
  try {
    await assert.rejects(withRunLock(REPO, 'LOCK-1', {
      cmd: 'reclaimer', waitSec: 0,
      hooks: {
        beforeReclaim: at === 'beforeReclaim' ? replace : undefined,
        afterReclaim: async () => {
          if (at === 'afterReclaim') await replace();
          // The old algorithm moved this live holder away here, admitting a fourth contender.
          await assert.rejects(withRunLock(REPO, 'LOCK-1', { cmd: 'fourth', waitSec: 0 }, () => {
            count(); active--;
          }), e => e.exitCode === 4);
        },
      },
    }, () => { count(); active--; }), e => e.exitCode === 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'))).cmd, 'third process');
    await assert.rejects(withRunLock(REPO, 'LOCK-1', { cmd: 'fifth', waitSec: 0 }, () => {
      count(); active--;
    }), e => e.exitCode === 4);
    assert.equal(maxActive, 1); n += 4;
  } finally { releaseThird(); await third; }
  await withRunLock(REPO, 'LOCK-1', { cmd: 'after release', waitSec: 0 }, () => { count(); active--; });
  assert.deepEqual(fs.readdirSync(lockRun), []); n++;
  console.log(`ok runlock: replacement ${at}, fourth during reclaim, fifth afterward -> max active ${maxActive}; no stranded directories`);
}
await withRunLock(REPO, 'LOCK-1', { cmd: 'test' }, () => own(replacement));
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'))), replacement); n++;
fs.rmSync(lockDir, { recursive: true });
console.log('ok runlock: release preserves another owner');
const reclaimDir = `${lockDir}.reclaim`;
for (const canonical of [true, false]) {
  if (canonical) own(stale);
  fs.mkdirSync(reclaimDir);
  fs.writeFileSync(path.join(reclaimDir, 'owner.json'), JSON.stringify(stale));
  await withRunLock(REPO, 'LOCK-1', { cmd: 'reclaim recovery', waitSec: 1 }, () => { n++; });
  assert.deepEqual(fs.readdirSync(lockRun), []); n++;
  console.log(`ok runlock: dead reclaim lock recovered, canonicalPresent=${canonical}; no stranded directories`);
}
for (const age of [300_000, 300_001, 86_400_000, 86_400_001, 365 * 86400_000]) {
  for (const reclaiming of [false, true]) {
    const live = { ...processIdentity(), acquiredAt: Date.now() - age, cmd: 'ancient live orch' };
    own(reclaiming ? stale : live);
    if (reclaiming) { fs.mkdirSync(reclaimDir); fs.writeFileSync(path.join(reclaimDir, 'owner.json'), JSON.stringify(live)); }
    const before = fs.readFileSync(path.join(lockDir, 'owner.json'));
    await assert.rejects(withRunLock(REPO, 'LOCK-1', { cmd: 'live never expires', waitSec: 0 }, () => assert.fail()),
      e => e.exitCode === 4 && /ancient live orch.*pid.*by hand/.test(e.message));
    assert.deepEqual(fs.readFileSync(path.join(lockDir, 'owner.json')), before); n += 2;
    fs.rmSync(lockDir, { recursive: true }); fs.rmSync(reclaimDir, { recursive: true, force: true });
  }
  console.log(`ok runlock: live run/reclaim owner age=${age} ms -> busy exit=4; bytes unchanged`);
}
for (const command of ['node orch.mjs gate T --job', null]) {
  const owner = { ...stale, pid: process.pid, acquiredAt: 0 };
  const observations = { alive: () => true, hasProc: () => false, command: () => command, now: () => Number.MAX_SAFE_INTEGER };
  assert.equal(deadReason(owner, observations), null); n++;
  own(owner);
  await assert.rejects(withRunLock(REPO, 'LOCK-1', { cmd: 'no-proc alive', waitSec: 0, observations }, () => assert.fail()), e => e.exitCode === 4); n++;
  fs.rmSync(lockDir, { recursive: true });
  console.log(`ok runlock: no-proc ps=${command === null ? 'unavailable/failed' : 'orch.mjs'} -> alive at any age`);
}
for (const delta of [-2001, -2000, -1999, 1999, 2000, 2001]) {
  assert.equal(deadReason(stale, { alive: () => true, hasProc: () => true, boot: () => 'old', start: () => stale.startedAt + delta }),
    Math.abs(delta) > 2000 ? 'pid was reused' : null); n++;
}
console.log('ok runlock: pid start differences +/-1999, +/-2000 -> live; +/-2001 ms -> reused');
for (const reclaiming of [false, true]) {
  for (const age of [59_999, 60_000, 60_001]) {
    const dir = reclaiming ? reclaimDir : lockDir;
    fs.mkdirSync(dir);
    const mtime = fs.statSync(dir).mtimeMs;
    const options = { cmd: 'ownerless', waitSec: 0, observations: { now: () => mtime + age } };
    // Acquirers create a lock complete (temp dir + rename), so an empty run.lock never belongs to a live acquirer:
    // it is replaced at any age. An ownerless reclaim dir is still preserved until 60 s.
    if (age > 60_000 || !reclaiming) await withRunLock(REPO, 'LOCK-1', options, () => { n++; });
    else {
      await withRunLock(REPO, 'LOCK-1', options, () => { n++; });
      assert.ok(fs.existsSync(reclaimDir)); n++;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(fs.readdirSync(lockRun), []); n++;
    console.log(`ok runlock: ownerless ${reclaiming ? 'reclaim' : 'run'} age=${age} ms -> ${reclaiming && age <= 60_000 ? 'preserved' : 'replaced'}`);
  }
}
fs.mkdirSync(lockDir); fs.utimesSync(lockDir, new Date(0), new Date(0));
fs.mkdirSync(reclaimDir); fs.writeFileSync(path.join(reclaimDir, 'owner.json'), JSON.stringify(replacement));
// An empty run.lock is replaced atomically even while a reclaim runs; that reclaimer judged "no owner" and never
// removes a lock whose owner record differs from what it judged.
await withRunLock(REPO, 'LOCK-1', { cmd: 'ownerless while reclaiming', waitSec: 0 }, () => {
  assert.ok(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).cmd === 'ownerless while reclaiming'); n++;
});
assert.ok(!fs.existsSync(lockDir)); n++;
fs.rmSync(reclaimDir, { recursive: true });
console.log('ok runlock: ownerless run older than 60 s preserved while live reclamation is in progress');

const cfgPath = path.join(REPO, '.orchestrate/config.json');
const cfgBase = JSON.parse(fs.readFileSync(cfgPath));
const fixtureConfig = (extra = {}) => write('.orchestrate/config.json', JSON.stringify({ ...cfgBase, ...extra, limits: { ...cfgBase.limits, runLockWaitSec: 0.15, ...extra.limits } }));
fixtureConfig();
orch(['start', 'SB-999'], 1);
assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-999'))); n++;
orch(['card', 'normalise', 'SB-999', '--from', 'missing.json'], 1);
assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-999'))); n++;
console.log('ok runlock: refused start/card edits leave no empty run directories for older releases');
write('src/e.mjs', 'export const e = 1;\n');
write('backlog/tasks/sb-5 - Card.md', card('SB-5', 'src/e.mjs'));
g('add', 'src/e.mjs', 'backlog/tasks/sb-5 - Card.md'); g('commit', '-q', '-m', 'lock fixture');
orch(['start', 'SB-5']);
const poll = async (check, label) => {
  const end = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < end, `timed out: ${label}`); await sleep(25); }
};
const env = extra => ({ ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESSIONS, ...extra });
const launch = (args, extra = {}) => {
  const child = spawn(process.execPath, [ORCH, ...args], { cwd: REPO, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
  return { child, done };
};
const readyLock = path.join(base, 'holder-ready');
const holder = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
import { withRunLock } from ${JSON.stringify(lockModule)};
await withRunLock(process.env.TEST_ROOT, 'SB-5', {cmd:'sleeping test command'}, async () => {
 fs.writeFileSync(process.env.TEST_READY, 'ready');
 await new Promise(resolve => process.stdin.once('data', resolve));
});
`, 'orch.mjs'], { env: { ...env(), TEST_ROOT: REPO, TEST_READY: readyLock }, stdio: ['pipe', 'inherit', 'inherit'] });
const holderDone = new Promise(resolve => holder.on('close', resolve));
await poll(() => fs.existsSync(readyLock), 'holder acquired lock');
try {
  const before = fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-5/state.json'));
  const activityBefore = fs.readFileSync(path.join(REPO, '.orchestrate/activity'));
  const t = Date.now();
  const busy = orch(['record', 'SB-5', 'worker'], 4);
  assert.ok(Date.now() - t >= 140); n++;
  has(busy, /SB-5 is busy: sleeping test command \(pid \d+, since .*holds it/);
  console.log(`busy evidence (exit 4): ${busy.trim()}`);
  // Every mutating entry point takes the lock before reading or deciding, including card edits and resume.
  for (const args of [
    ['start', 'SB-5'], ['gate', 'SB-5'], ['fix', 'SB-5'], ['recheck', 'SB-5'], ['restore', 'SB-5'], ['finish', 'SB-5'],
    ['push', 'SB-5'], ['park', 'SB-5', '--reason', 'fixture'], ['resolve', 'SB-5', '--checked', 'fixture'],
    ['prompt', 'SB-5', 'worker', '--resume'], ['card', 'normalise', 'SB-5', '--from', 'missing.json'],
    ['card', 'split', 'SB-5', '--from', 'missing.json'], ['card', 'set-aside', 'SB-5'],
  ]) has(orch(args, 4), /sleeping test command/);
  assert.deepEqual(fs.readFileSync(path.join(REPO, '.orchestrate/runs/SB-5/state.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(REPO, '.orchestrate/activity')), activityBefore); n += 2;
  const ro = Date.now();
  orch(['status', 'SB-5']); orch(['prompt', 'SB-5', 'worker']); orch(['next']);
  assert.ok(Date.now() - ro < 5000, 'read-only commands do not wait on the held lock'); n++;
} finally { holder.stdin.end('release'); await holderDone; }
console.log('ok runlock: all mutating commands exit 4 before writes; read-only commands do not wait');
fixtureConfig({ limits: { runLockWaitSec: 5 } });
const resumes = await Promise.all([launch(['prompt', 'SB-5', 'worker', '--resume']).done, launch(['prompt', 'SB-5', 'worker', '--resume']).done]);
assert.deepEqual(resumes.map(r => r.code).sort(), [0, 3]);
assert.equal(state('SB-5').events.filter(e => e.kind === 'restart').length, 1); n += 2;
console.log('ok runlock: concurrent resumes -> exactly one success and one restart event');

// 9. Detached output parity, one execution for multiple attachers, and bounded waits.
write('src/e.mjs', 'export const e = 2;\n', WT('SB-5'));
write('.orchestrate/runs/SB-5/inbox/worker.md', 'done\n'); orch(['record', 'SB-5', 'worker']);
const run5 = path.join(REPO, '.orchestrate/runs/SB-5');
const job5 = () => JSON.parse(fs.readFileSync(path.join(run5, 'gate-job.json')));
fixtureConfig({ checks: ['node -e "process.exit(0)"'] });
// Durations differ between two runs under load ("in 0 s" / "in 1 s", "(4 s)"): compare everything else.
const normalizeTime = text => text.replace(/\b\d+(?:\.\d+)? (?:s|min)\b/g, '<time>');
const fgPass = orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '1' });
const bgPass = orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' });
assert.equal(normalizeTime(bgPass), normalizeTime(fgPass)); n++;
fixtureConfig({ checks: ['node -e "process.exit(1)"'] });
const fgFail = orch(['gate', 'SB-5'], 2, { ORCH_GATE_FOREGROUND: '1' });
const bgFail = orch(['gate', 'SB-5'], 2, { ORCH_GATE_FOREGROUND: '' });
assert.equal(normalizeTime(bgFail), normalizeTime(fgFail)); n++;
console.log('ok detached gate: PASS and FAIL stdout/exit codes match foreground');

const executions = path.join(base, 'gate-executions');
const started = path.join(base, 'gate-started');
const releaseGate = path.join(base, 'release-gate');
const failGate = path.join(base, 'fail-gate');
// External signals keep the suite deterministic even on a busy host; no sleep-based contention assumptions.
write('scripts/slow-gate.mjs', `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(executions)}, 'run\\n');
fs.writeFileSync(${JSON.stringify(started)}, 'ready');
while (!fs.existsSync(${JSON.stringify(releaseGate)})) await new Promise(resolve => setTimeout(resolve, 25));
if (fs.existsSync(${JSON.stringify(failGate)})) process.exit(1);
`);
const slowHarness = { name: 'single', command: `node ${JSON.stringify(path.join(REPO, 'scripts/slow-gate.mjs'))}`, paths: ['src/**'] };
const card5 = path.join(REPO, 'backlog/tasks/sb-5 - Card.md');
// Prior parity gates moved the card to In Check. Exercise the checker's exact In Progress edge input.
fs.writeFileSync(card5, fs.readFileSync(card5, 'utf8').replace(/^status: .*$/m, 'status: In Progress'));
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 0.2 } });
const launchExpired = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started), 'detached harness started');
const expired = await launchExpired.done;
assert.equal(expired.code, 4); has(expired.stdout, /gate SB-5 round 0 still running .*orch gate SB-5 attaches again/);
console.log(`attach-expired evidence (exit 4): ${expired.stdout.trim()}`);
has(orch(['status', 'SB-5']), /gate running \(since .*\nnext: orch gate SB-5/);
has(orch(['next']), /gate running \(since .*\nnext: orch gate SB-5/);
const status5 = JSON.parse(orch(['status', 'SB-5', '--json']))[0];
assert.equal(status5.runningGate.pid, job5().pid); assert.match(status5.next, /orch gate SB-5/); n += 2;
const card5Bytes = fs.readFileSync(card5, 'utf8');
assert.match(card5Bytes, /status: In Progress/); n++;
const next5 = JSON.parse(orch(['next', '--json'])).find(r => r.id === 'SB-5');
assert.deepEqual(next5.gate, { running: true, since: job5().at });
assert.equal(next5.next, 'orch gate SB-5'); n += 2;
console.log(`next --json evidence (In Progress): ${JSON.stringify(next5)}`);
const liveBefore = fs.readFileSync(path.join(run5, 'state.json'));
for (const args of [['fix', 'SB-5'], ['record', 'SB-5', 'worker'], ['restore', 'SB-5']]) {
  const busy = orch(args, 4);
  has(busy, /SB-5 is busy: gate job of SB-5/);
  if (args[0] === 'fix') console.log(`gate busy evidence (exit 4): ${busy.trim()}`);
}
const cardInput = path.join(base, 'normalise.json');
const validCard = { title: 'Changed title', goal: 'Update the fixture source with the requested behavior.',
  acceptance: ['The fixture source exports the requested value.'], owned: ['src/e.mjs'], kind: 'code', dependencies: [] };
fs.writeFileSync(cardInput, JSON.stringify(validCard));
const splitInput = path.join(base, 'split.json');
fs.writeFileSync(splitInput, JSON.stringify([validCard, { ...validCard, title: 'Second child', owned: ['src/d.mjs'] }]));
const cardsBefore = fs.readdirSync(path.dirname(card5));
for (const sub of ['normalise', 'split', 'set-aside']) {
  for (const flags of [[], ['--dry-run'], ['--dry-run=false'], ['--dry-run=true']]) {
    const args = ['card', sub, 'SB-5', ...(sub === 'set-aside' ? [] : ['--from', sub === 'split' ? splitInput : cardInput]), ...flags];
    has(orch(args, 4), /SB-5 is busy: gate job of SB-5/);
    assert.equal(fs.readFileSync(card5, 'utf8'), card5Bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(card5)), cardsBefore);
    assert.deepEqual(fs.readFileSync(path.join(run5, 'state.json')), liveBefore); n += 3;
    console.log(`ok card ${sub} ${flags.join(' ') || '(no flag)'}: exit=4 cardChanged=false stateChanged=false gateLockStillHeld=${fs.existsSync(path.join(run5, 'run.lock'))}`);
  }
}
assert.deepEqual(fs.readFileSync(path.join(run5, 'state.json')), liveBefore); n++;
const samePid = job5().pid;
const againExpired = orch(['gate', 'SB-5'], 4, { ORCH_GATE_FOREGROUND: '' });
assert.equal(job5().pid, samePid); has(againExpired, /still running/);
// The keeper sees jobs on every OS, before looking at a harness lock or /proc.
const busyKeeper = JSON.parse(orch(['keeper', '--json']));
assert.match(busyKeeper.reason, /a gate of SB-5 \(pid/); n++;
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 30 } });
const attachA = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
const attachB = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await sleep(300); fs.writeFileSync(releaseGate, 'go');
const attached = await Promise.all([attachA.done, attachB.done]);
assert.deepEqual(attached.map(r => r.code), [0, 0], attached.map(r => `${r.code}: ${r.stdout}${r.stderr}`).join('\n---\n'));
assert.equal(attached[0].stdout, attached[1].stdout);
assert.equal(fs.readFileSync(executions, 'utf8').split('run').length - 1, 1); n += 3;
console.log('ok detached gate: one harness for both attachers; expiry leaves job alive; status/next/keeper see it; fix/record/restore busy');

// Expire, finish with FAIL, then attach after completion: return the uncollected receipt exactly once.
for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
fs.writeFileSync(failGate, 'fail');
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 0.2 } });
const beforeFailExecutions = fs.readFileSync(executions, 'utf8').split('run').length - 1;
const failExpired = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started) && !job5().done, 'uncollected FAIL started');
const failExpiry = await failExpired.done;
assert.equal(failExpiry.code, 4); n++;
fs.writeFileSync(releaseGate, 'go');
await poll(() => job5().done && !fs.existsSync(path.join(run5, 'run.lock')), 'uncollected FAIL completed');
const firstFailJob = job5();
assert.equal(firstFailJob.collected, false); assert.equal(firstFailJob.exitCode, 2); n += 2;
has(firstFailJob.text, /GATE: FAIL/);
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 30 } });
const collectedFail = orch(['gate', 'SB-5'], 2, { ORCH_GATE_FOREGROUND: '' });
assert.equal(collectedFail, `${firstFailJob.text}\n${firstFailJob.next}\n`);
assert.equal(job5().pid, firstFailJob.pid); assert.equal(job5().collected, true);
const afterFailExecutions = fs.readFileSync(executions, 'utf8').split('run').length - 1;
assert.equal(afterFailExecutions, beforeFailExecutions + 1); n += 4;
console.log(`ok detached gate: expire -> complete -> attach: first=FAIL returned=FAIL exit=2 extraSpawns=0 extraHarnesses=0 collected=${job5().collected}`);
fs.rmSync(failGate);
has(orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' }), /GATE: PASS/);
assert.notEqual(job5().pid, firstFailJob.pid); assert.equal(job5().collected, true);
assert.equal(fs.readFileSync(executions, 'utf8').split('run').length - 1, afterFailExecutions + 1); n += 3;
console.log('ok detached gate: further gate after collection -> new job, one new harness, PASS');

// 10. Killing only the attaching CLI does not kill the gate. Killing the job itself is INFRA and retries this round.
for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
const lostAttach = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started) && !job5().done, 'second detached job started');
const lostJob = job5();
lostAttach.child.kill('SIGKILL'); await lostAttach.done;
assert.equal(deadReason(job5()), null); n++;
const laterAttach = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await sleep(100); fs.writeFileSync(releaseGate, 'go');
const survived = await laterAttach.done;
assert.equal(survived.code, 0); assert.equal(job5().pid, lostJob.pid); n += 2;
console.log('ok detached gate: job survives killed coordinator CLI and later attach gets its result');

for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
const doomed = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started) && !job5().done, 'job to kill started');
const killedJob = job5();
const doomedPeer = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await sleep(200);
process.kill(killedJob.pid, 'SIGKILL');
fs.writeFileSync(releaseGate, 'go'); // permit orphaned harness descendants to finish too
const [recovered, peerRecovery] = await Promise.all([doomed.done, doomedPeer.done]);
assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
assert.equal(peerRecovery.code, 0, peerRecovery.stdout + peerRecovery.stderr); n++;
has(recovered.stdout + peerRecovery.stdout, /INFRA  previous gate job of round 0 stopped without a result/);
has(recovered.stdout, /GATE: PASS/); assert.doesNotMatch(recovered.stdout, /GATE: FAIL/);
assert.notEqual(job5().pid, killedJob.pid); assert.equal(state('SB-5').round, 0); n += 3;
console.log('ok detached gate: dead job -> INFRA and one replacement; both attachers finish, same round, never FAIL');



// Simultaneous first callers also share a job while the parent hands its lock to the child.
for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
const countBefore = fs.readFileSync(executions, 'utf8');
const delayedJob = path.join(base, 'delay-job.mjs');
fs.writeFileSync(delayedJob, "if (process.argv.includes('--job')) await new Promise(resolve => setTimeout(resolve, 500));\n");
const initialEnv = { ORCH_GATE_FOREGROUND: '', NODE_OPTIONS: `--import=${delayedJob}` };
const initialA = launch(['gate', 'SB-5'], initialEnv);
const initialB = launch(['gate', 'SB-5'], initialEnv);
await poll(() => fs.existsSync(started) && !job5().done, 'simultaneous first callers');
await sleep(300); fs.writeFileSync(releaseGate, 'go');
const initialResults = await Promise.all([initialA.done, initialB.done]);
assert.deepEqual(initialResults.map(r => r.code), [0, 0]);
assert.equal(initialResults[0].stdout, initialResults[1].stdout);
assert.equal(fs.readFileSync(executions, 'utf8').slice(countBefore.length).split('run').length - 1, 1); n += 3;
console.log('ok detached gate: simultaneous first callers share one job through lock handoff');

// A child that never acknowledges ownership is killed after 10 s; the foreground fallback keeps the lock.
fixtureConfig({ checks: ['node -e 0'], harnesses: [] });
const preload = path.join(base, 'exit-job.mjs');
fs.writeFileSync(preload, "if (process.argv.includes('--job')) await new Promise(resolve => setTimeout(resolve, 15000));\n");
const fallbackAt = Date.now();
const fallback = orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '', NODE_OPTIONS: `--import=${preload}` });
assert.ok(Date.now() - fallbackAt >= 9900); n++;
has(fallback, /WARN  detached gate could not acquire its lock within 10 s.*running in the foreground/);
has(fallback, /GATE: PASS/);
assert.ok(!fs.existsSync(path.join(run5, 'run.lock'))); n++;
console.log('ok detached gate: failed handshake -> WARN and foreground fallback, lock released');

// A legacy writer ignoring the new lock cannot make a job overwrite a different phase or round.
for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 30 } });
const changedJob = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started) && !job5().done, 'legacy-writer fixture');
const legacyState = { ...state('SB-5'), phase: 'worked', round: 1 };
const legacyBytes = JSON.stringify(legacyState);
fs.writeFileSync(path.join(run5, 'state.json'), legacyBytes);
fs.writeFileSync(releaseGate, 'go');
const discarded = await changedJob.done;
assert.equal(discarded.code, 3); has(discarded.stdout, /INFRA  gate result discarded: the round or phase changed/);
assert.equal(fs.readFileSync(path.join(run5, 'state.json'), 'utf8'), legacyBytes); n += 2;
console.log('ok detached gate: legacy round/phase change discards result as INFRA without overwriting state');

// 11. A receipt belongs to the phase and round its gate left, never to a parked/merged or advanced run.
fixtureConfig({ checks: ['node -e 0'], harnesses: [], limits: { gateWaitSec: 30 } });
const setUncollected = () => {
  const job = { ...job5(), collected: false };
  fs.writeFileSync(path.join(run5, 'gate-job.json'), JSON.stringify(job));
  fs.writeFileSync(path.join(run5, `gate-job-${job.token}.json`), JSON.stringify(job));
  return job;
};
for (const phase of ['parked', 'merged', 'ready']) {
  orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' });
  const originalState = fs.readFileSync(path.join(run5, 'state.json'));
  const completed = setUncollected();
  if (phase === 'parked') orch(['park', 'SB-5', '--reason', 'receipt validation fixture']);
  else fs.writeFileSync(path.join(run5, 'state.json'), JSON.stringify({ ...state('SB-5'), phase }));
  const output = orch(['gate', 'SB-5'], phase === 'ready' ? 0 : 1, { ORCH_GATE_FOREGROUND: '' });
  if (phase === 'ready') {
    assert.notEqual(job5().token, completed.token); n++;
    console.log('ok receipt validation: advanced phase ready -> new job; obsolete PASS not returned');
  } else {
    has(output, new RegExp(`SB-5 is ${phase}`));
    assert.doesNotMatch(output, /GATE: PASS|delegate the checker/);
    assert.equal(job5().collected, true); n += 2;
    console.log(`ok receipt validation: phase=${phase} exit=1 collected=true stdoutHasPASS=false`);
  }
  fs.writeFileSync(path.join(run5, 'state.json'), originalState);
}
const oldRoundJob = setUncollected();
const beforeRound = state('SB-5');
fs.writeFileSync(path.join(run5, 'state.json'), JSON.stringify({ ...beforeRound, round: beforeRound.round + 1 }));
orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' });
assert.notEqual(job5().token, oldRoundJob.token); assert.equal(job5().round, beforeRound.round + 1); n += 2;
console.log('ok receipt validation: earlier-round receipt -> new job in current round');

// 12. Foreground recovery must retire a detached FAIL instead of returning it after the current PASS.
fixtureConfig({ checks: ['node -e "process.exit(1)"'], harnesses: [] });
orch(['gate', 'SB-5'], 2, { ORCH_GATE_FOREGROUND: '' });
const obsoleteFail = setUncollected();
fixtureConfig({ checks: ['node -e 0'], harnesses: [] });
const recoveredForeground = orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '1' });
has(recoveredForeground, /GATE: PASS/);
assert.equal(state('SB-5').gate.pass, true); assert.equal(job5().collected, true); assert.equal(job5().superseded, true); n += 3;
const afterForeground = orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' });
has(afterForeground, /GATE: PASS/); assert.doesNotMatch(afterForeground, /GATE: FAIL/);
assert.notEqual(job5().token, obsoleteFail.token); n += 2;
const obsoleteReceipt = JSON.parse(fs.readFileSync(path.join(run5, `gate-job-${obsoleteFail.token}.json`)));
assert.equal(obsoleteReceipt.collected, true); assert.equal(obsoleteReceipt.superseded, true); n += 2;
console.log('ok foreground recovery: exit=0 statePass=true oldJobCollected=true superseded=true; next detached exit=0 PASS');

// 13. Pause a real attacher after it joins A. Finish/collect A, finish/collect B in the same round, then resume it.
// The preloader pauses one filesystem read, rather than relying on scheduler timing or mocking the job runner.
for (const file of [started, releaseGate]) fs.rmSync(file, { force: true });
fs.writeFileSync(failGate, 'fail');
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 0.2 } });
const raceA = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
await poll(() => fs.existsSync(started) && !job5().done, 'receipt race A started');
assert.equal((await raceA.done).code, 4); n++;
const jobA = job5();
const pausedAt = path.join(base, 'attacher-paused');
const resumeAttach = path.join(base, 'resume-attacher');
const pauseModule = path.join(base, 'pause-attacher.mjs');
fs.writeFileSync(pauseModule, `import fs from 'node:fs';
const original = fs.readFileSync;
let reads = 0;
fs.readFileSync = function(file, ...args) {
  const value = original.call(this, file, ...args);
  if (String(file) === ${JSON.stringify(fs.realpathSync(path.join(run5, 'gate-job.json')))} && ++reads === 2) {
    fs.writeFileSync(${JSON.stringify(pausedAt)}, 'joined A');
    while (!fs.existsSync(${JSON.stringify(resumeAttach)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return value;
};
`);
fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 30 } });
const delayedAttacher = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '', NODE_OPTIONS: `--import=${pauseModule}` });
try {
  await poll(() => fs.existsSync(pausedAt), 'attacher joined A and paused');
  fs.writeFileSync(releaseGate, 'go');
  await poll(() => job5().done && !fs.existsSync(path.join(run5, 'run.lock')), 'race A completed');
  const resultA = job5();
  assert.equal(resultA.exitCode, 2); n++;
  orch(['gate', 'SB-5'], 2, { ORCH_GATE_FOREGROUND: '' });
  for (const file of [started, releaseGate, failGate]) fs.rmSync(file, { force: true });
  fixtureConfig({ checks: [], harnesses: [slowHarness], limits: { gateWaitSec: 0.2 } });
  const raceB = launch(['gate', 'SB-5'], { ORCH_GATE_FOREGROUND: '' });
  await poll(() => fs.existsSync(started) && !job5().done, 'receipt race B started');
  assert.equal((await raceB.done).code, 4); n++;
  const jobB = job5();
  assert.notEqual(jobB.token, jobA.token); assert.equal(jobB.round, jobA.round); n += 2;
  fs.writeFileSync(releaseGate, 'go');
  await poll(() => job5().done && !fs.existsSync(path.join(run5, 'run.lock')), 'race B completed');
  orch(['gate', 'SB-5'], 0, { ORCH_GATE_FOREGROUND: '' });
  fs.writeFileSync(resumeAttach, 'resume');
  const receivedA = await delayedAttacher.done;
  assert.equal(receivedA.code, 2, receivedA.stdout + receivedA.stderr);
  assert.equal(receivedA.stdout, `${resultA.text}\n${resultA.next}\n`);
  assert.equal(job5().token, jobB.token); assert.equal(job5().exitCode, 0); n += 4;
  console.log('ok receipt identity: attacher joined job-A -> A finished FAIL -> B finished PASS -> attacher exit=2 GATE: FAIL (job-A)');
} finally { fs.writeFileSync(resumeAttach, 'resume'); fs.writeFileSync(releaseGate, 'go'); }
const receipts = fs.readdirSync(run5).filter(file => /^gate-job-\d+-[\d.]+\.json$/.test(file));
// Contention: several processes, very short sections, quick releases. Never two inside (the mkdir inside would throw),
// never a crash (a release racing an acquirer's rename once failed with ENOTEMPTY).
{
  const stressRun = path.join(REPO, '.orchestrate/runs/STRESS-1');
  fs.mkdirSync(stressRun, { recursive: true });
  const inside = path.join(stressRun, 'inside');
  const body = `import fs from 'node:fs'; const { withRunLock } = await import(${JSON.stringify(lockModule)});
for (let i = 0; i < 25; i++) await withRunLock(${JSON.stringify(REPO)}, 'STRESS-1', { cmd: 'stress', waitSec: 60 }, () => {
  fs.mkdirSync(${JSON.stringify(inside)}); fs.rmdirSync(${JSON.stringify(inside)}); });`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; }); p.on('close', code => resolve({ code, err }));
  })));
  assert.deepEqual(results.map(r => r.code), results.map(() => 0), results.map(r => r.err).join('\n')); n++;
  assert.deepEqual(fs.readdirSync(stressRun), [], 'no lock, temp or moved directory left'); n++;
  fs.rmSync(stressRun, { recursive: true });
  console.log('ok runlock stress: 6 processes x 25 sections -> never two inside, no crash, nothing left');
}

// Lock handoff: a job whose lock was never transferred stops without running; a transferred lock is held, then released.
{
  const { holdTransferredLock, transferRunLock } = await import(lockModule);
  let ran = false;
  await assert.rejects(holdTransferredLock(REPO, 'SB-5', 'never-transferred', () => { ran = true; }, 300), e => e.exitCode === 3);
  assert.equal(ran, false); n += 2;
  await takeRunLock(REPO, 'SB-5', { cmd: 'handoff test', waitSec: 0 }, async ({ lockDir }) => {
    transferRunLock(lockDir, process.pid, 'handed', 'gate job of SB-5');
  });
  assert.ok(fs.existsSync(path.join(run5, 'run.lock')), 'a transferred lock is not released by the giver'); n++;
  await holdTransferredLock(REPO, 'SB-5', 'handed', () => { ran = true; });
  assert.equal(ran, true); assert.ok(!fs.existsSync(path.join(run5, 'run.lock')), 'the receiver releases it'); n += 2;
  console.log('ok lock handoff: never transferred -> exit 3, nothing ran; transferred -> held by the receiver, released by it');
}

// Beyond the newest 3, only receipts of jobs started more than a day ago are removed: every receipt of this run
// (all younger) is kept, so an attacher still waiting for an older job finds its own.
assert.ok(receipts.length >= 3, receipts.join(', '));
assert.ok(receipts.includes(`gate-job-${jobA.token}.json`));
assert.ok(receipts.includes(`gate-job-${job5().token}.json`)); n += 3;
console.log(`ok receipt retention: ${receipts.length} receipts of today kept (newest 3 always; older than a day removed)`);

console.log(`e2e-recovery: ${n} checks passed in ${REPO}`);
