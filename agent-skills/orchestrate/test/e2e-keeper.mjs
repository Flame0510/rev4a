// End to end for the campaign keeper (orch campaign, orch keeper): when the coordinator of an active campaign must be
// woken, when to wait, when the owner must decide, backoff and the stop after wakes without progress, and the end of
// the campaign. Time is simulated with ORCH_NOW. node test/e2e-keeper.mjs [dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-keeper-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
fs.mkdirSync(REPO, { recursive: true });

let n = 0;
const SESSIONS = path.join(base, 'sessions.json');
const T0 = Date.now();
const at = minutes => String(T0 + minutes * 60000);
const orch = (args, { code = 0, now } = {}) => {
  // The runtime's sessions come from SESSIONS (none by default: unknown), never from an openclaw on this machine.
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESSIONS, ...(now ? { ORCH_NOW: now } : {}) } });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const keeper = minutes => JSON.parse(orch(['keeper', '--json'], { now: at(minutes) }).trim().split('\n').at(-1));
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const is = (d, action, re, label) => { assert.equal(d.action, action, `${label}: ${JSON.stringify(d)}`); if (re) assert.match(d.reason, re, label); n++; };
const campaign = () => JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/campaign.json'), 'utf8'));
const card = (id, owned) => `---\nid: ${id}\ntitle: Card ${id}\nstatus: To Do\ndependencies: []\nmodified_files:\n  - ${owned}\npriority: medium\n---\n`;
const setStatus = (id, status) => {
  const f = path.join(REPO, `backlog/tasks/${id.toLowerCase()} - Card.md`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^status: .*$/m, `status: ${status}`));
};

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node -e 0' } }));
for (const [id, f] of [['SB-1', 'src/a.mjs'], ['SB-2', 'src/b.mjs'], ['SB-3', 'src/c.mjs']]) { write(f, '// x\n'); write(`backlog/tasks/${id.toLowerCase()} - Card.md`, card(id, f)); }
write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
g('add', '-A'); g('commit', '-q', '-m', 'p');
const cfg = {
  confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'], tests: { rule: 'off' },
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'] }, roles: { worker: 'w', checker: 'c' },
  limits: { workerTimeoutSec: 3600, checkerTimeoutSec: 1800 },
};
write('.orchestrate/config.json', JSON.stringify(cfg));

// 1. No campaign: the keeper does nothing.
is(keeper(0), 'off', /no active campaign/, 'no campaign');
orch(['campaign', 'start'], { code: 1 });
has(orch(['campaign', 'start', '--session', 'agent:main:dashboard:coord', '--by', 'Owner']), /campaign started: every To Do card · coordinator agent:main:dashboard:coord/, 'started');
orch(['campaign', 'start', '--session', 'other'], { code: 1 }); // one campaign at a time

// 2. Eligible cards: wait while the coordinator was active recently, wake it when it has been quiet.
is(keeper(2), 'wait', /acted 2 min ago/, 'recent activity');
let d = keeper(11);
is(d, 'wake', /3 card\(s\) can start and nobody works on them/, 'quiet: wake');
assert.equal(d.session, 'agent:main:dashboard:coord'); assert.equal(d.next, 'orch start SB-1'); n += 2;
assert.match(d.message, /^\[orch keeper\] Campaign "every To Do card" is active and nothing is moving: .* Run orch status, then: orch start SB-1\. After every closure run orch next/, 'wake message'); n++;

// 3. Backoff between wakes (10, 20 min), then the owner after 3 wakes without progress, reported once.
is(keeper(15), 'wait', /woken 4 min ago, next wake not before 10 min/, 'backoff 1');
is(keeper(22), 'wake', null, 'second wake');
is(keeper(35), 'wait', /next wake not before 20 min/, 'backoff 2');
is(keeper(43), 'wake', null, 'third wake');
d = keeper(90);
is(d, 'escalate', /3 wakes without progress/, 'owner after 3 wakes');
assert.equal(d.session, 'agent:main:dashboard:coord', 'notices name the session'); n++;
assert.match(d.notify, /needs the owner/); n++;
is(keeper(95), 'wait', /already reported to the owner/, 'reported once');

// 4. Progress resets the count; a worker within its time limit is waited for, past it the coordinator is woken.
orch(['start', 'SB-1']);
const nowMin = () => Math.ceil((Date.now() - T0) / 60000);
is(keeper(nowMin() + 30), 'wait', /SB-1: worker within its time limit/, 'worker running');
d = keeper(nowMin() + 71);
is(d, 'wake', /SB-1: no step from the worker for \d+ min, past its time limit; check its session.*sessions_spawn/, 'worker overdue');
assert.equal(d.next, 'check the worker session of SB-1; start it again only if it is gone'); n++;
assert.equal(campaign().wakes.count, 1, 'count restarted after progress'); n++;
// The coordinator may have started it again (no orch command records that): a full time limit before the next wake.
orch(['status']);
is(keeper(nowMin() + 71 + 30), 'wait', /SB-1: worker within its time limit/, 'overdue: clock restarted at the wake');

// 5. A step that waits for the coordinator (worked → gate) wakes it once it is quiet.
write('src/a.mjs', '// changed\n', path.resolve(REPO, '../.worktrees/orch-SB-1'));
write('.orchestrate/runs/SB-1/inbox/worker.md', 'done\n'); orch(['record', 'SB-1', 'worker']);
is(keeper(nowMin() + 2), 'wait', /SB-1 \(worked\): the coordinator acted/, 'just recorded');
d = keeper(nowMin() + 12);
is(d, 'wake', /SB-1 waits for the coordinator \(worked\)/, 'worked: wake');
assert.equal(d.next, 'orch gate SB-1'); n++;

// 6. A ready card without standing consent: the owner is told once; the other cards keep moving (the coordinator is
// woken for them), and the keeper never wakes it for the ready card itself.
orch(['gate', 'SB-1']);
write(ckr('SB-1'), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', 'SB-1', 'checker']);
write('.orchestrate/config.json', JSON.stringify({ ...cfg, merge: { approval: 'owner', standing: null, protectedBranches: ['main'] } }));
d = keeper(nowMin() + 30);
is(d, 'wake', /2 card\(s\) can start/, 'ready without consent: the others move');
assert.match(d.notify, /SB-1 is ready and waits for the owner's merge ok/); n++;
d = keeper(nowMin() + 35);
assert.equal(d.notify, undefined, `ready reported once: ${JSON.stringify(d)}`); n++;
write('.orchestrate/config.json', JSON.stringify(cfg));
is(keeper(nowMin() + 40), 'wake', /SB-1 waits for the coordinator \(ready\)/, 'standing consent: wake to finish');

// 7. A running harness: wait, whatever else.
fs.mkdirSync(path.join(REPO, '.orchestrate/harness.lock'), { recursive: true });
fs.writeFileSync(path.join(REPO, '.orchestrate/harness.lock/pid'), String(process.pid));
is(keeper(nowMin() + 60), 'wait', /running: a harness/, 'harness running');
fs.rmSync(path.join(REPO, '.orchestrate/harness.lock'), { recursive: true });

// 8. A merge that needs the owner blocks everything else.
orch(['finish', 'SB-1']);
const sf = path.join(REPO, '.orchestrate/runs/SB-1/state.json');
fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf, 'utf8')), untestedMerge: true }));
is(keeper(nowMin() + 70), 'escalate', /a merge needs the owner: SB-1 \(merged result never checked\)/, 'blocked queue');
orch(['resolve', 'SB-1', '--checked', 'checks on develop']);

// 9. A scoped campaign looks only at its own cards; every remaining one blocked → the owner; all done → done, then off.
orch(['campaign', 'stop']);
is(keeper(nowMin() + 80), 'off', null, 'stopped');
has(orch(['campaign', 'start', '--session', 'agent:main:dashboard:coord', '--scope', 'SB-3']), /campaign started: SB-3/, 'scoped');
setStatus('SB-3', 'Blocked');
d = keeper(nowMin() + 95);
is(d, 'escalate', /every remaining card waits: SB-3 \(blocked \(parked\)\)/, 'all remaining blocked');
setStatus('SB-3', 'Done');
d = keeper(nowMin() + 100);
is(d, 'done', /every card in the campaign is done/, 'done');
assert.match(d.notify, /is complete/); n++;
is(keeper(nowMin() + 105), 'off', null, 'a finished campaign stops itself');

// 10. The OpenClaw job script: runs the keeper headlessly, wakes the recorded session only on wake.
const js = orch(['campaign', 'job-script']);
assert.match(js, /const r = await exec\(\{ command: ".*orch\.mjs' keeper --json" \}\);/); n++;
assert.match(js, /const res = await sessions_send\(\{ sessionKey: k\.session, message: text, timeoutSeconds: 0 \}\);/); n++;
assert.match(js, /prev\?\.error === error/, 'unreadable output reported once'); n++;
// Run the script the way OpenClaw does (exec, sessions_send, trigger as globals): a failed wake still notifies.
const runJob = async (keeperOut, send) => {
  const body = js.split('\n').filter(l => !l.startsWith('//')).join('\n');
  const fn = new Function('exec', 'sessions_send', 'trigger', `return (async () => { ${body} })();`);
  return fn(async () => ({ aggregated: keeperOut }), send, { state: null });
};
let job = await runJob(JSON.stringify({ action: 'wake', session: 'S', message: 'm', notify: 'owner note' }), async () => { throw new Error('unknown session S'); });
assert.match(job.notify, /owner note\n\[orch keeper\] could not reach the coordinator S: unknown session S/); n++;
const sent = [];
job = await runJob(JSON.stringify({ action: 'wake', session: 'S', message: 'm' }), async a => { sent.push(a); });
assert.deepEqual(sent, [{ sessionKey: 'S', message: 'm', timeoutSeconds: 0 }]); assert.equal(job.notify, undefined); n += 2;
// A notice for the owner goes to the coordinator's conversation (where the owner reads), with the wake or alone.
sent.length = 0;
job = await runJob(JSON.stringify({ action: 'wake', session: 'S', message: 'm', notify: 'SB-9 is ready.' }), async a => { sent.push(a); });
assert.match(sent[0].message, /^m\n\nSB-9 is ready\. This is for the owner: tell them in one line/); assert.equal(job.notify, undefined); n += 2;
sent.length = 0;
job = await runJob(JSON.stringify({ action: 'escalate', session: 'S', notify: 'SB-9 is ready.' }), async a => { sent.push(a); });
assert.equal(sent.length, 1); assert.match(sent[0].message, /^SB-9 is ready\. This is for the owner/); assert.equal(job.notify, undefined); n += 3;
// A send that resolves with an error status (not delivered) keeps the notice in the script's result.
job = await runJob(JSON.stringify({ action: 'escalate', session: 'S', notify: 'SB-9 is ready.' }), async () => ({ status: 'forbidden', error: 'not visible' }));
assert.match(job.notify, /SB-9 is ready\.\n\[orch keeper\] could not reach the coordinator S: not visible/); n++;
job = await runJob(JSON.stringify({ action: 'escalate', session: 'S', notify: 'N.' }), async () => ({ status: 'skipped' }));
assert.match(job.notify, /could not reach the coordinator S: not delivered \(skipped\)/); n++;
job = await runJob(JSON.stringify({ action: 'escalate', session: 'S', notify: 'N.' }), async () => ({ status: 'accepted' }));
assert.equal(job.notify, undefined, 'accepted is delivered'); n++;
job = await runJob(JSON.stringify({ action: 'escalate', session: 'S', notify: 'N.' }), async () => ({ content: [], details: { status: 'forbidden', error: 'not visible' } }));
assert.match(job.notify, /could not reach the coordinator S: not visible/, 'raw tool result'); n++;
job = await runJob('null', async () => {});
assert.match(job.notify, /unreadable output/, 'a null line is unreadable'); n++;
job = await runJob('Error: boom', async () => {});
assert.match(job.notify, /unreadable output/); n++;
const again = await new Function('exec', 'sessions_send', 'trigger', `return (async () => { ${js.split('\n').filter(l => !l.startsWith('//')).join('\n')} })();`)(async () => ({ aggregated: 'Error: boom' }), async () => {}, { state: job.state });
assert.equal(again.notify, undefined, 'same error not reported twice'); n++;
const noTrigger = await new Function('exec', 'sessions_send', `return (async () => { ${js.split('\n').filter(l => !l.startsWith('//')).join('\n')} })();`)(async () => ({ aggregated: 'Error: boom' }), async () => {});
assert.match(noTrigger.notify, /unreadable output/, 'no trigger global'); n++;
has(orch(['campaign', 'status']), /no campaign|campaign stopped/, 'status after the end');

// 11. Bad input to campaign start; an unconfirmed config is a quiet off, not an error.
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-99'], { code: 1 }); // a typo would end the campaign at once
orch(['campaign', 'start', '--session', 'S', '--scope', ','], { code: 1 });
orch(['campaign', 'start', '--session', 'S', '--idle-minutes', '0'], { code: 1 });
orch(['campaign', 'start', '--session', 'S', '--idle-minutes', 'soon'], { code: 1 });
write('.orchestrate/config.json', JSON.stringify({ ...cfg, confirmed: false }));
is(keeper(nowMin()), 'off', /not confirmed/, 'unconfirmed config');
write('.orchestrate/config.json', JSON.stringify(cfg));

// 12. A scoped campaign ignores open runs outside its scope.
orch(['start', 'SB-2']);
write('src/b.mjs', '// changed\n', path.resolve(REPO, '../.worktrees/orch-SB-2'));
write('.orchestrate/runs/SB-2/inbox/worker.md', 'done\n'); orch(['record', 'SB-2', 'worker']);
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-3']);
is(keeper(nowMin() + 30), 'done', /every card in the campaign is done/, 'out-of-scope run ignored');

// 13. A card in progress without a run is reported, not counted as done.
write('src/d.mjs', '// x\n'); write('backlog/tasks/sb-4 - Card.md', card('SB-4', 'src/d.mjs').replace('status: To Do', 'status: In Progress'));
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-4']);
d = keeper(nowMin() + 30);
is(d, 'escalate', /SB-4 \(In Progress without an open run\)/, 'in progress without a run');
orch(['campaign', 'stop']);

// 14. Any orch command counts as activity; a merge with steps left still wakes the coordinator.
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-2']);
orch(['status']);
is(keeper(nowMin() + 2), 'wait', /SB-2 \(worked\): the coordinator acted/, 'orch status is activity');
const sf2 = path.join(REPO, '.orchestrate/runs/SB-2/state.json');
fs.writeFileSync(sf2, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf2, 'utf8')), phase: 'merged', finishPending: ['tracker'] }));
is(keeper(nowMin() + 15), 'wake', /SB-2 waits for the coordinator \(merged, still to do: tracker\)/, 'merged with steps left');

// 15. A run at its round limit goes to the owner, not to the coordinator; a running harness does not make the keeper
// forget what it reported, and one that runs longer than any sub-agent may is reported as hung.
fs.writeFileSync(sf2, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf2, 'utf8')), phase: 'rejected', round: 2, finishPending: [] }));
d = keeper(nowMin() + 30);
is(d, 'escalate', /SB-2 reached the round limit \(rejected\): round limit reached \(2\/2\)/, 'round limit: owner');
assert.match(d.notify, /round limit/); n++;
fs.mkdirSync(path.join(REPO, '.orchestrate/harness.lock'), { recursive: true });
fs.writeFileSync(path.join(REPO, '.orchestrate/harness.lock/pid'), String(process.pid));
is(keeper(nowMin() + 35), 'wait', /running: a harness/, 'harness during an escalation');
d = keeper(nowMin() + 35 + 80);
is(d, 'escalate', /a harness .* has been running for 80 min: it may be hung/, 'hung harness');
is(keeper(nowMin() + 35 + 85), 'wait', /already reported/, 'hung reported once');
fs.rmSync(path.join(REPO, '.orchestrate/harness.lock'), { recursive: true });
d = keeper(nowMin() + 35 + 90);
is(d, 'wait', /already reported to the owner: SB-2 reached the round limit/, 'round limit not reported again after the harness');
assert.equal(d.notify, undefined); n++;

// 16. A stop that lands while the keeper is deciding wins: nobody is woken and the campaign stays stopped.
const slow = path.join(base, 'slow.mjs');
fs.writeFileSync(slow, "import fs from 'node:fs';\nconst o = fs.readdirSync;\nfs.readdirSync = function (p, ...a) { if (String(p).endsWith('/runs')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); return o.call(this, p, ...a); };\n");
const late = new Promise(resolve => {
  const c = spawn(process.execPath, ['--import', slow, ORCH, 'keeper', '--json'], { cwd: REPO, env: { ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESSIONS, ORCH_NOW: at(nowMin() + 60) } });
  let o = ''; c.stdout.on('data', x => { o += x; }); c.on('close', () => resolve(o));
});
await new Promise(r => setTimeout(r, 1000));
orch(['campaign', 'stop']);
d = JSON.parse((await late).trim().split('\n').at(-1));
is(d, 'off', /stopped or restarted during this check/, 'stop during a keeper check');
assert.equal(campaign().active, false, 'the stop was not overwritten'); n++;

// 17. Splitting a card keeps the campaign on its children; the split card waits for them.
write('src/e.mjs', '// x\n'); write('src/f.mjs', '// x\n'); write('src/g.mjs', '// x\n'); write('test/e.test.mjs', '// x\n'); write('test/f.test.mjs', '// x\n');
write('backlog/tasks/sb-5 - Card.md', card('SB-5', 'src/g.mjs'));
g('add', '-A'); g('commit', '-q', '-m', 'more');
write(path.join('..', 'split.json'), JSON.stringify([
  { title: 'Part one of five', goal: 'Move the first half of the parsing into src/e.mjs so it can be tested on its own.', acceptance: ['src/e.mjs exports parseHead and test/e.test.mjs covers an empty input.'], owned: ['src/e.mjs', 'test/e.test.mjs'], kind: 'code' },
  { title: 'Part two of five', goal: 'Move the second half of the parsing into src/f.mjs so it can be tested on its own.', acceptance: ['src/f.mjs exports parseTail and test/f.test.mjs covers an empty input.'], owned: ['src/f.mjs', 'test/f.test.mjs'], kind: 'code' },
]));
orch(['card', 'split', 'SB-5', '--from', path.join(base, 'split.json')]);
has(orch(['next', '--all']), /not SB-5: closes its split cards, still open: SB-5\.1 \(To Do\), SB-5\.2 \(To Do\)/, 'split card waits');
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-5']);
d = keeper(nowMin() + 30);
is(d, 'wake', /2 card\(s\) can start/, 'children in scope');
assert.equal(d.next, 'orch start SB-5.1'); n++;

// 18. The owner chooses to split a card at its round limit: its run is set aside, the children run, then the card
// comes back as their closure.
orch(['campaign', 'stop']);
// A step that fails half-way (here a locked worktree) stops with what to do, and orch card set-aside finishes it.
const wt2 = path.resolve(REPO, '../.worktrees/orch-SB-2');
g('worktree', 'lock', wt2);
has(orch(['card', 'split', 'SB-2', '--from', path.join(base, 'split.json')], { code: 1 }), /could not move the worktree [^]*fix that, then: orch card set-aside SB-2/, 'half-way split');
assert.ok(fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-2/state.json')), 'run still in place after a failed step'); n++;
has(orch(['status', 'SB-2']), /next: orch card set-aside SB-2 \(a split set this run aside half-way/, 'half set aside: the next step');
has(orch(['fix', 'SB-2'], { code: 1 }), /SB-2 is being set aside by a split: orch card set-aside SB-2/, 'no fix on a run being set aside');
has(orch(['card', 'split', 'SB-2', '--from', path.join(base, 'split.json')], { code: 1 }), /split already and its run is half set aside/, 'no second split');
g('worktree', 'unlock', wt2);
has(orch(['card', 'set-aside', 'SB-2']), /SB-2: its run \(rejected, round 2\) was set aside/, 'set-aside finishes it');
assert.ok(!fs.existsSync(path.join(REPO, '.orchestrate/runs/SB-2')), 'run set aside'); n++;
assert.equal(fs.readdirSync(path.join(REPO, '.orchestrate/archive')).filter(x => x.startsWith('SB-2-before-split-')).length, 1); n++;
assert.match(g('branch', '--list', 'orch/SB-2-before-split-*'), /orch\/SB-2-before-split-/); n++;
has(orch(['next', '--all']), /not SB-2: closes its split cards, still open: SB-2\.1 \(To Do\), SB-2\.2 \(To Do\)/, 'set-aside card waits');
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-2']);
for (const f of fs.readdirSync(path.join(REPO, 'backlog/tasks')).filter(x => x.startsWith('sb-2.'))) {
  const p = path.join(REPO, 'backlog/tasks', f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^status: .*$/m, 'status: Done'));
}
// Three keeper checks at once (a manual run beside the job): one wake, not three.
const runKeeper = () => new Promise(resolve => {
  const c = spawn(process.execPath, [ORCH, 'keeper', '--json'], { cwd: REPO, env: { ...process.env, HOME: base, ORCH_SESSIONS_JSON: SESSIONS, ORCH_NOW: at(nowMin() + 30) } });
  let o = ''; c.stdout.on('data', x => { o += x; }); c.on('close', () => resolve(JSON.parse(o.trim().split('\n').at(-1))));
});
const three = await Promise.all([runKeeper(), runKeeper(), runKeeper()]);
assert.equal(three.filter(k => k.action === 'wake').length, 1, JSON.stringify(three)); n++;
assert.equal(three.find(k => k.action === 'wake').next, 'orch start SB-2', 'the closure card starts after its children'); n++;
has(orch(['start', 'SB-2']), /started SB-2: worktree/, 'a set-aside card starts again');
// A split card may not depend on the card it is split from.
fs.writeFileSync(path.join(base, 'loop.json'), JSON.stringify(JSON.parse(fs.readFileSync(path.join(base, 'split.json'), 'utf8')).map(c => ({ ...c, dependencies: ['SB-3'] }))));
has(orch(['card', 'split', 'SB-3', '--from', path.join(base, 'loop.json')], { code: 2 }), /depends on SB-3, the card it is split from/, 'child on parent refused');
orch(['campaign', 'start', '--session', 'S', '--scope', ''], { code: 1 });

// 19. A worker's report left in the inbox and never recorded (its completion did not reach the coordinator): once it
// has sat there for idleMinutes and the coordinator is quiet, the keeper wakes it to record it, before the time limit.
write('.orchestrate/runs/SB-2/inbox/worker.md', 'done\n');
is(keeper(nowMin() + 5), 'wait', /SB-2: worker within its time limit/, 'fresh report: wait');
d = keeper(nowMin() + 45);
is(d, 'wake', /SB-2: the worker left its report \d+ min ago and nobody recorded it/, 'unrecorded report: wake');
assert.equal(d.next, 'orch record SB-2 worker'); n++;

// 20. Checker reports: one left by an earlier round (older name, written before this round's gate) is neither woken
// for nor recorded; this round's checker-r<round>-<tag>.md is.
orch(['record', 'SB-2', 'worker']);
write('src/b.mjs', '// changed again\n', path.resolve(REPO, '../.worktrees/orch-SB-2'));
const old = path.join(REPO, '.orchestrate/runs/SB-2/inbox/checker-a.md');
orch(['gate', 'SB-2']);
write('.orchestrate/runs/SB-2/inbox/checker-a.md', 'EXECUTED: x -> ok\nVERDICT: PASS\n');
fs.utimesSync(old, new Date(T0 - 3600000), new Date(T0 - 3600000)); // before this round's gate
is(keeper(nowMin() + 20), 'wait', /SB-2: checker within its time limit/, 'stale checker report: no wake');
has(orch(['record', 'SB-2', 'checker'], { code: 1 }), /no report at .*checker-r0-a\.md/, 'old name not taken for a brief of this release');
assert.ok(fs.existsSync(old), 'a refused record leaves the report in the inbox'); n++;
// A brief written by an older release (it names checker-a.md): the old name is taken when newer than the gate, and
// refused when older.
const brief = path.join(REPO, '.orchestrate/runs/SB-2/prompts/checker-r0-a.md');
const newBrief = fs.readFileSync(brief, 'utf8');
fs.writeFileSync(brief, newBrief.split('checker-r0-a.md').join('checker-a.md'));
has(orch(['record', 'SB-2', 'checker'], { code: 1 }), /older than this round \(its gate\): a leftover of an earlier round/, 'older brief: stale report refused');
fs.utimesSync(old, new Date(), new Date());
d = keeper(nowMin() + 20);
is(d, 'wake', /SB-2: the checker left its report/, 'older brief: its fresh report wakes');
assert.equal(d.next, 'orch record SB-2 checker --tag a'); n++;
fs.writeFileSync(brief, newBrief);
fs.rmSync(old);
write('.orchestrate/runs/SB-2/inbox/checker-r0-a.md', 'EXECUTED: x -> ok\nVERDICT: PASS\n');
d = keeper(nowMin() + 31); // after the backoff of the wake above
is(d, 'wake', /SB-2: the checker left its report \d+ min ago/, 'this round\'s checker report: wake');
assert.equal(d.next, 'orch record SB-2 checker --tag a'); n++;
has(orch(['record', 'SB-2', 'checker']), /checker a: PASS/, 'this round\'s report recorded');

// 21. The runtime's sessions show a sub-agent the run waits for that is not running: never started (the coordinator
// ended its turn first) or ended without a report. Sessions of another runtime (no coordinator session in the list)
// are ignored.
orch(['campaign', 'stop']);
orch(['campaign', 'start', '--session', 'S', '--scope', 'SB-5']);
orch(['start', 'SB-5.1']);
const sessions = rows => fs.writeFileSync(SESSIONS, JSON.stringify({ sessions: rows }));
sessions([{ key: 'agent:other:main', label: null, status: 'done', updatedAt: Date.now() }]);
is(keeper(nowMin() + 20), 'wait', /SB-5\.1: worker within its time limit/, 'another runtime: unknown');
sessions([{ key: 'S', status: 'done', updatedAt: Date.now() }]);
d = keeper(nowMin() + 20);
is(d, 'wake', /SB-5\.1: no OpenClaw session "SB-5\.1 worker r0" was started for this round/, 'never started: wake');
assert.match(d.next, /^start it now: delegate the worker/); n++;
sessions([{ key: 'S', status: 'done', updatedAt: Date.now() }, { key: 'agent:main:subagent:w', label: 'SB-5.1 worker r0', status: 'running', updatedAt: Date.now() }]);
is(keeper(nowMin() + 31), 'wait', /SB-5\.1: worker within its time limit/, 'running: wait');
sessions([{ key: 'S', status: 'done', updatedAt: Date.now() }, { key: 'agent:main:subagent:w', label: 'SB-5.1 worker r0', status: 'done', updatedAt: Date.now() }]);
d = keeper(nowMin() + 45);
is(d, 'wake', /SB-5\.1: the session "SB-5\.1 worker r0" ended without leaving a report/, 'ended without report: wake');
assert.match(d.next, /^read its last answer \(sessions_history\)/); n++;
// Restarted with the same label: OpenClaw lists the newest first; the running one counts, not the ended one.
sessions([{ key: 'S', status: 'done', updatedAt: Date.now() }, { key: 'agent:main:subagent:w2', label: 'SB-5.1 worker r0 (retry)', status: 'running', updatedAt: Date.now() }, { key: 'agent:main:subagent:w', label: 'SB-5.1 worker r0', status: 'done', updatedAt: Date.now() - 1000 }]);
is(keeper(nowMin() + 70), 'wait', /SB-5\.1: worker within its time limit/, 'restarted: the running session counts');
// Ended with a report just written: not "ended without a report" (the report rule takes it once it is idleMinutes old).
sessions([{ key: 'S', status: 'done', updatedAt: Date.now() }, { key: 'agent:main:subagent:w', label: 'SB-5.1 worker r0', status: 'done', updatedAt: Date.now() }]);
write('.orchestrate/runs/SB-5.1/inbox/worker.md', 'done\n');
d = keeper(nowMin() + 70);
assert.doesNotMatch(d.reason, /ended without leaving a report/, `fresh report: ${JSON.stringify(d)}`); n++;
fs.rmSync(SESSIONS);

function has(t, re, label) { assert.match(t, re, label); n++; }
console.log(`e2e-keeper: ${n} checks passed in ${REPO}`);
