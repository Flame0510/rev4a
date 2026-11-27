// End to end for delivery "pr" against a real, throwaway GitHub repository (never a project's):
//   ORCH_PR_SANDBOX=owner/repo node test/e2e-pr.mjs [dir]
// Skipped without ORCH_PR_SANDBOX. Needs gh logged in. Every branch and card of a run carries a run id; at the end
// the run closes its open PRs and deletes its remote branches. Scenarios: a clean card, a correction round on the
// same PR, a push by someone else, the base moving before the merge, a PR merged before an interrupted finish, and a
// base change that conflicts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SANDBOX = process.env.ORCH_PR_SANDBOX;
if (!SANDBOX) { console.log('e2e-pr: skipped (set ORCH_PR_SANDBOX=owner/repo, a throwaway repository)'); process.exit(0); }
const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pr-'));
fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
const REPO = path.join(base, 'p'); const OTHER = path.join(base, 'other');
const RUN = `T${Date.now().toString(36).toUpperCase()}`;
const URL_ = `https://github.com/${SANDBOX}.git`;

let n = 0;
const run = (cmd, args, cwd, ok = true) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (ok) assert.equal(r.status, 0, `${cmd} ${args.join(' ')}:\n${r.stdout}${r.stderr}`);
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
const g = (cwd, ...a) => run('git', a, cwd).out;
const gh = (...a) => run('gh', a, REPO).out;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const state = id => JSON.parse(fs.readFileSync(path.join(REPO, `.orchestrate/runs/${id}/state.json`), 'utf8'));
const WT = id => path.resolve(REPO, `../.worktrees/orch-${id}`);
const card = (id, file) => `---\nid: ${id}\ntitle: Card ${id}\nstatus: To Do\ndependencies: []\nmodified_files:\n  - ${file}\npriority: medium\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nSandbox card ${id}.\n<!-- SECTION:DESCRIPTION:END -->\n`;
const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'].map(x => `${RUN}-${x}`);

function cleanup() {
  const prs = spawnSync('gh', ['pr', 'list', '--repo', SANDBOX, '--state', 'open', '--json', 'number,headRefName'], { encoding: 'utf8' });
  for (const p of JSON.parse(prs.stdout || '[]').filter(p => p.headRefName.startsWith(`orch/${RUN}-`))) {
    spawnSync('gh', ['pr', 'close', String(p.number), '--repo', SANDBOX], { encoding: 'utf8' });
  }
  // Only branches that exist, each with a time limit: a cleanup must never hang the run.
  const opts = { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  const heads = spawnSync('git', ['ls-remote', '--heads', 'origin'], opts).stdout ?? '';
  for (const b of [...ids.map(id => `orch/${id}`), `alt-${RUN}`]) if (heads.includes(`refs/heads/${b}\n`)) spawnSync('git', ['push', '-q', 'origin', '--delete', b], opts);
}
process.on('exit', cleanup);

// The sandbox: main and develop exist (made on the first run), one card file per scenario, pushed to develop.
run('git', ['clone', '-q', URL_, REPO], base);
g(REPO, 'config', 'user.name', 'orch-test'); g(REPO, 'config', 'user.email', 'orch-test@invalid');
if (!run('git', ['rev-parse', '--verify', '-q', 'origin/main'], REPO, false).out) {
  write('README.md', '# orch-pr-sandbox\n\nThrowaway repository for the orchestrate skill tests.\n');
  write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node -e 0' } }));
  write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "T"\n');
  g(REPO, 'checkout', '-q', '-b', 'main'); g(REPO, 'add', '-A'); g(REPO, 'commit', '-q', '-m', 'sandbox'); g(REPO, 'push', '-q', 'origin', 'main');
  g(REPO, 'checkout', '-q', '-b', 'develop'); g(REPO, 'push', '-q', 'origin', 'develop');
} else {
  g(REPO, 'checkout', '-q', 'develop');
}
for (const [i, id] of ids.entries()) write(`backlog/tasks/${id.toLowerCase()} - Card.md`, card(id, `src/${id}/**`));
const MOVE_FLAG = path.join(base, 'move-develop-once');
write('scripts/move-develop.mjs', `import fs from 'node:fs'; import { execFileSync as x } from 'node:child_process';
const flag = process.argv[2], other = process.argv[3];
if (fs.existsSync(flag)) { fs.rmSync(flag); x('git', ['pull', '-q', 'origin', 'develop'], { cwd: other });
  fs.writeFileSync(other + '/src/during-' + Date.now() + '.txt', 'moved during the merge checks\\n');
  x('git', ['add', '-A'], { cwd: other }); x('git', ['commit', '-q', '-m', 'develop moved during the checks'], { cwd: other }); x('git', ['push', '-q', 'origin', 'develop'], { cwd: other }); }
`);
write(`backlog/tasks/${ids[11].toLowerCase()} - Card.md`, card(ids[11], `src/${ids[11]}/**`).replace('priority: medium', `checks:\n  - node scripts/move-develop.mjs ${MOVE_FLAG} ${OTHER}\npriority: medium`));
write('src/shared.txt', `line for ${RUN}\n`);
g(REPO, 'add', '-A'); g(REPO, 'commit', '-q', '-m', `cards for run ${RUN}`); g(REPO, 'push', '-q', 'origin', 'develop');
run('git', ['clone', '-q', '-b', 'develop', URL_, OTHER], base);
g(OTHER, 'config', 'user.name', 'someone-else'); g(OTHER, 'config', 'user.email', 'else@invalid');
write('.orchestrate/config.json', JSON.stringify({
  confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'], tests: { rule: 'off' },
  delivery: { mode: 'pr', remote: 'origin' },
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'] }, roles: { worker: 'w', checker: 'c' },
}));

const toChecked = (id, round = 0) => {
  write(`src/${id}/file.txt`, `${id} round ${round}\n`, WT(id));
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n'); orch(['record', id, 'worker']);
  has(orch(['gate', id]), /GATE: PASS\n[\s\S]*next: orch push /, `${id}: gate PASS asks for the push`);
  const o = orch(['push', id]);
  write(ckr(id), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', id, 'checker']);
  return o;
};

// 1. A clean card: the PR is opened at the gated tree, merged with a merge commit whose parent is that sha.
const [A, B, C, D, E, F, G, H, I, J, K, L, M, N, P] = ids;
orch(['start', A]);
let o = toChecked(A);
has(o, /pushed T\w+-1 [0-9a-f]{9} · PR #\d+ https:\/\/github\.com\/\S+ \(opened\)/, 'PR opened');
const shaA = state(A).sha;
assert.equal(g(REPO, 'ls-remote', 'origin', `refs/heads/orch/${A}`).split('\t')[0], shaA); n++;
o = orch(['finish', A]);
has(o, /merged T\w+-1 into develop: [0-9a-f]{9} · status Done/, 'merged');
const prA = JSON.parse(gh('pr', 'view', String(state(A).pr.number), '--json', 'state,mergeCommit,headRefOid'));
assert.equal(prA.state, 'MERGED'); assert.equal(prA.headRefOid, shaA); n += 2;
g(REPO, 'fetch', '-q', 'origin');
assert.ok(g(REPO, 'rev-list', '--parents', '-n', '1', prA.mergeCommit.oid).split(' ').includes(shaA), 'merge commit has the checked sha as parent'); n++;
assert.equal(run('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/orch/${A}`], REPO, false).code, 2, 'remote branch deleted'); n++;
assert.equal(g(REPO, 'rev-parse', 'develop'), g(REPO, 'rev-parse', 'origin/develop'), 'local develop fast-forwarded'); n++;

// 2. A correction round updates the same PR with a new sha.
orch(['start', B]);
write(`src/${B}/file.txt`, 'first\n', WT(B));
write(`.orchestrate/runs/${B}/inbox/worker.md`, 'done\n'); orch(['record', B, 'worker']); orch(['gate', B]);
o = orch(['push', B]); const prB = state(B).pr.number; const sha1 = state(B).sha;
write(ckr(B), 'EXECUTED: x -> broken\nVERDICT: FAIL\n'); orch(['record', B, 'checker']);
orch(['fix', B]);
o = toChecked(B, 1);
has(o, new RegExp(`· PR #${prB} \\S+ \\(updated\\)`), 'same PR updated');
assert.notEqual(state(B).sha, sha1); n++;
has(orch(['finish', B]), /merged T\w+-2 into develop/, 'merged after a round');

// 3. Someone else pushes to the task branch after orch: finish merges nothing.
orch(['start', C]); toChecked(C);
g(OTHER, 'fetch', '-q', 'origin', `orch/${C}`); g(OTHER, 'checkout', '-q', '-b', `x-${C}`, `origin/orch/${C}`);
write('src/extra.txt', 'not orch\n', OTHER); g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'someone else'); g(OTHER, 'push', '-q', 'origin', `HEAD:orch/${C}`);
o = orch(['finish', C], 1);
has(o, /is at [0-9a-f]{9}, not the checked [0-9a-f]{9}: someone else pushed\. Nothing was merged/, 'foreign push refused');
assert.equal(JSON.parse(gh('pr', 'view', String(state(C).pr.number), '--json', 'state')).state, 'OPEN'); n++;

// 4. The base moves after the check: it is merged into the task branch, checked, pushed, then the PR is merged.
orch(['start', D]); toChecked(D);
g(OTHER, 'checkout', '-q', 'develop'); g(OTHER, 'pull', '-q', 'origin', 'develop');
write(`src/moved-${D}.txt`, 'develop moved\n', OTHER); g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'develop moved'); g(OTHER, 'push', '-q', 'origin', 'develop');
o = orch(['finish', D]);
has(o, /develop had moved: merged it into orch\/T\w+-4, checks passed, pushed [0-9a-f]{9}/, 'base merged in');
has(o, /merged T\w+-4 into develop/, 'then merged');

// 5. The PR was merged before an interrupted finish recorded it: finish records it, merges nothing again.
orch(['start', E]); toChecked(E);
gh('pr', 'merge', String(state(E).pr.number), '--merge', '--match-head-commit', state(E).sha);
o = orch(['finish', E]);
has(o, /PR #\d+ was already merged at [0-9a-f]{9} \(an interrupted finish\): recorded it/, 'interrupted finish recorded');

// 6. A base change that conflicts with the card: nothing is merged, the PR stays open.
orch(['start', F]); write('src/shared.txt', `card ${F}\n`, WT(F));
fs.writeFileSync(path.join(REPO, `backlog/tasks/${F.toLowerCase()} - Card.md`), card(F, 'src/shared.txt'));
g(OTHER, 'pull', '-q', 'origin', 'develop'); write('src/shared.txt', 'develop changed it\n', OTHER);
g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'conflicting'); g(OTHER, 'push', '-q', 'origin', 'develop');
write(`.orchestrate/runs/${F}/inbox/worker.md`, 'done\n'); orch(['record', F, 'worker']); orch(['gate', F]); orch(['push', F]);
write(ckr(F), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', F, 'checker']);
o = orch(['finish', F], 2);
has(o, /develop moved and does not merge cleanly into orch\/T\w+-6/, 'conflict refused');
assert.equal(JSON.parse(gh('pr', 'view', String(state(F).pr.number), '--json', 'state')).state, 'OPEN'); n++;

// 7. A PR retargeted to another branch is never merged there.
orch(['start', G]); toChecked(G);
g(OTHER, 'fetch', '-q', 'origin'); g(OTHER, 'push', '-q', 'origin', `origin/develop:refs/heads/alt-${RUN}`);
const retarget = to => gh('api', '-X', 'PATCH', `repos/${SANDBOX}/pulls/${state(G).pr.number}`, '-f', `base=${to}`);
retarget(`alt-${RUN}`);
has(orch(['finish', G], 1), new RegExp(`now targets alt-${RUN}, not develop: someone changed it\\. Nothing was merged`), 'retargeted PR refused');
retarget('develop');
has(orch(['finish', G]), /merged T\w+-7 into develop/, 'merged once set back');

// 8. The worker's own commits never reach GitHub: one commit of the gated tree on top of the base.
orch(['start', H]);
write('src/secret.txt', 'FAKESECRET-1234567890\n', WT(H)); g(WT(H), 'add', '-A'); g(WT(H), 'commit', '-q', '-m', 'wip');
fs.rmSync(path.join(WT(H), 'src/secret.txt')); g(WT(H), 'add', '-A'); g(WT(H), 'commit', '-q', '-m', 'undo');
toChecked(H);
g(REPO, 'fetch', '-q', 'origin', `orch/${H}`);
assert.equal(g(REPO, 'log', '-S', 'FAKESECRET', '--oneline', 'FETCH_HEAD'), '', 'the removed secret is not in the pushed history'); n++;
assert.equal(g(REPO, 'rev-parse', 'FETCH_HEAD^1'), state(H).base, 'one commit on the base'); n++;
orch(['finish', H]);

// 9. A base merge interrupted after its commit (not pushed): adopted, pushed, merged.
orch(['start', I]); toChecked(I);
g(OTHER, 'checkout', '-q', 'develop'); g(OTHER, 'pull', '-q', 'origin', 'develop'); write(`src/i-${RUN}.txt`, 'moved\n', OTHER);
g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'develop moved (I)'); g(OTHER, 'push', '-q', 'origin', 'develop');
g(WT(I), 'fetch', '-q', 'origin', 'develop'); const baseI = g(WT(I), 'rev-parse', 'FETCH_HEAD');
g(WT(I), 'merge', '-q', '--no-ff', '-m', 'Merge develop into the branch', baseI);
const sI = state(I); sI.baseMerge = { base: baseI }; fs.writeFileSync(path.join(REPO, `.orchestrate/runs/${I}/state.json`), JSON.stringify(sI));
o = orch(['finish', I]);
has(o, /adopted the base merge [0-9a-f]{9} of an interrupted finish/, 'committed base merge adopted');
has(o, /merged T\w+-9 into develop/, 'then merged');

// 10. A base merge interrupted while its checks ran (merge in progress): aborted, redone, merged.
orch(['start', J]); toChecked(J);
g(OTHER, 'pull', '-q', 'origin', 'develop'); write(`src/j-${RUN}.txt`, 'moved\n', OTHER);
g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'develop moved (J)'); g(OTHER, 'push', '-q', 'origin', 'develop');
g(WT(J), 'fetch', '-q', 'origin', 'develop'); const baseJ = g(WT(J), 'rev-parse', 'FETCH_HEAD');
g(WT(J), 'merge', '-q', '--no-ff', '--no-commit', baseJ);
const sJ = state(J); sJ.baseMerge = { base: baseJ }; fs.writeFileSync(path.join(REPO, `.orchestrate/runs/${J}/state.json`), JSON.stringify(sJ));
o = orch(['finish', J]);
has(o, /aborted a base merge left in progress by an interrupted finish/, 'in-progress base merge aborted');
has(o, /develop had moved: merged it into orch\/T\w+-10, checks passed/, 'redone');
has(o, /merged T\w+-10 into develop/, 'then merged');

// 11. A closed PR: nothing pushed, nothing merged.
orch(['start', K]); toChecked(K);
gh('pr', 'close', String(state(K).pr.number));
const remoteK = g(REPO, 'ls-remote', 'origin', `refs/heads/orch/${K}`).split('\t')[0];
has(orch(['finish', K], 1), /is closed: nothing was pushed or merged/, 'closed PR refused');
assert.equal(g(REPO, 'ls-remote', 'origin', `refs/heads/orch/${K}`).split('\t')[0], remoteK, 'remote branch untouched'); n++;

// 12. The base moves again while the merge checks run: merged in again, the merged result is the checked tree.
orch(['start', L]); write(`src/${L}/file.txt`, 'L\n', WT(L));
write(`.orchestrate/runs/${L}/inbox/worker.md`, 'done\n'); orch(['record', L, 'worker']); orch(['gate', L]); orch(['push', L]);
write(ckr(L), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', L, 'checker']);
g(OTHER, 'pull', '-q', 'origin', 'develop'); write(`src/l-${RUN}.txt`, 'moved\n', OTHER);
g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'develop moved (L)'); g(OTHER, 'push', '-q', 'origin', 'develop');
fs.writeFileSync(MOVE_FLAG, '1');
o = orch(['finish', L]);
assert.equal((o.match(/develop had moved: merged it into/g) ?? []).length, 2, 'merged in twice'); n++;
assert.ok(!/ATTENTION/.test(o), 'merged result is the checked tree'); n++;
const prL = JSON.parse(gh('pr', 'view', String(state(L).pr.number), '--json', 'mergeCommit'));
g(REPO, 'fetch', '-q', 'origin');
assert.equal(g(REPO, 'rev-parse', `${prL.mergeCommit.oid}^{tree}`), g(REPO, 'rev-parse', `${state(L).sha}^{tree}`)); n++;

// 13. A base branch missing on the remote: start fails and leaves no run behind.
const cfgFile = path.join(REPO, '.orchestrate/config.json'); const cfgText = fs.readFileSync(cfgFile, 'utf8');
fs.writeFileSync(cfgFile, cfgText.replace('"baseBranch":"develop"', '"baseBranch":"no-such-branch"'));
has(orch(['start', M], 1), /git fetch origin no-such-branch/, 'missing base refused');
assert.ok(!fs.existsSync(path.join(REPO, `.orchestrate/runs/${M}`)), 'no run left behind'); n++;
fs.writeFileSync(cfgFile, cfgText);

// 14. Cleanup after the merge keeps a remote branch someone pushed to after it (first independent review, HIGH).
orch(['start', N]); toChecked(N);
gh('pr', 'merge', String(state(N).pr.number), '--merge', '--match-head-commit', state(N).sha);
g(OTHER, 'fetch', '-q', 'origin', `orch/${N}`); g(OTHER, 'checkout', '-q', '-B', `x-${N}`, 'FETCH_HEAD');
write('src/after-merge.txt', 'follow-up\n', OTHER); g(OTHER, 'add', '-A'); g(OTHER, 'commit', '-q', '-m', 'follow-up'); g(OTHER, 'push', '-q', 'origin', `HEAD:orch/${N}`);
o = orch(['finish', N]);
has(o, new RegExp(`remote branch orch/${N} kept: it is at [0-9a-f]{9}, not the merged [0-9a-f]{9} \\(someone pushed after the merge\\)`), 'foreign tip kept');
assert.ok(g(REPO, 'ls-remote', 'origin', `refs/heads/orch/${N}`), 'branch still there'); n++;

// 15. The PR retargeted while GitHub merges it (a gh wrapper retargets right before the real merge): parked as an
//     unsafe merge, never recorded as merged into develop (first independent review, HIGH).
const realGh = run('sh', ['-c', 'command -v gh'], REPO).out;
const wrap = path.join(base, 'ghwrap'); fs.mkdirSync(wrap, { recursive: true });
fs.writeFileSync(path.join(wrap, 'gh'), `#!/bin/sh
if [ "$1" = pr ] && [ "$2" = merge ]; then "${realGh}" api -X PATCH "repos/${SANDBOX}/pulls/$3" -f base=alt-${RUN} >/dev/null; fi
exec "${realGh}" "$@"
`, { mode: 0o755 });
g(OTHER, 'fetch', '-q', 'origin'); run('git', ['push', '-q', 'origin', `origin/develop:refs/heads/alt-${RUN}`], OTHER, false);
orch(['start', P]); toChecked(P);
const r15 = spawnSync(process.execPath, [ORCH, 'finish', P], { cwd: REPO, encoding: 'utf8', env: { ...process.env, PATH: `${wrap}:${process.env.PATH}` } });
assert.equal(r15.status, 2, r15.stdout + r15.stderr); n++;
has(r15.stderr, new RegExp(`UNSAFE MERGE: PR #\\d+ was merged into alt-${RUN} at [0-9a-f]{9}, not into develop`), 'unsafe merge named');
assert.equal(state(P).phase, 'parked'); n++;
has(orch(['status', P]), /phase parked[\s\S]*next: tell the owner: UNSAFE MERGE/, 'status shows it');
has(orch(['next', '--all'], 2), /UNSAFE MERGE[\s\S]*no new task starts before that/, 'an unsafe merge blocks the queue');
has(orch(['finish', P], 2), /was already merged, unsafely/, 'finish says what it is');
has(orch(['park', P, '--reason', 'other'], 1), /parked as an unsafe merge; that reason stays/, 'park cannot hide it');
has(orch(['resolve', P, '--checked', 'owner reverted the merge on alt']), /recorded as settled/, 'unsafe merge resolved');

// 16. An unchecked merged result stays visible and blocks new starts until it is resolved (first review, MEDIUM).
const sA = state(A); sA.untestedMerge = true; fs.writeFileSync(path.join(REPO, `.orchestrate/runs/${A}/state.json`), JSON.stringify(sA));
has(orch(['status']), /ATTENTION: the merged result [0-9a-f]{9} on develop is not the checked tree/, 'status shows the unchecked merge');
has(orch(['next'], 2), /no new task starts before that/, 'next blocks');
const blockedJson = JSON.parse(orch(['next', '--json'], 2));
assert.equal(blockedJson.blocked[0].id, A); assert.equal(blockedJson.blocked[0].untested, true); n += 2;
has(orch(['start', M], 1), /\(merged result never checked\): settle it first/, 'start refused');
has(orch(['resolve', A, '--checked', 'npm run check on develop']), /recorded as settled/, 'resolved');
assert.ok(!/ATTENTION/.test(orch(['status'])), 'gone after resolve'); n++;

console.log(`e2e-pr: ${n} checks passed against ${SANDBOX} (run ${RUN})`);
