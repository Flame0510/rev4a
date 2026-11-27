// Delivery through pull requests on GitHub (`delivery.mode: "pr"`): the remote branch, the PR and its merge. git for
// the branch, the GitHub CLI (`gh`, already logged in) for the PR. Every function checks the real state first, so a
// command that stopped half-way can run again without pushing or merging twice.
import { spawnSync } from 'node:child_process';
import { getNetworkTimeout, git, OrchError } from './util.mjs';

export function gh(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: getNetworkTimeout() * 1000 });
  if (r.error?.code === 'ENOENT') throw new OrchError('delivery "pr" needs the GitHub CLI (gh), logged in: it is not installed');
  const res = { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  // gh prints warnings ("Warning: 3 uncommitted changes") before the real error: name the error.
  res.reason = res.err.split('\n').filter(l => l.trim() && !/^warning:/i.test(l.trim())).join(' | ').slice(0, 300) || `exit ${res.code}`;
  if (!allowFail && res.code !== 0) throw new OrchError(`gh ${args.slice(0, 2).join(' ')}: ${res.reason}`);
  return res;
}

/** The sha a branch has on the remote, or null when it does not exist there. */
export function remoteSha(root, remote, branch) {
  const r = git(['ls-remote', '--heads', remote, `refs/heads/${branch}`], root, { allowFail: true });
  if (r.code !== 0) throw new OrchError(`git ls-remote ${remote}: ${r.err.split('\n')[0]}`);
  return r.out.split('\n').map(l => l.split('\t')).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? null;
}

/** Fetches the base branch and returns its sha on the remote. */
export function fetchBase(root, remote, base) {
  const r = git(['fetch', '-q', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`], root, { allowFail: true });
  if (r.code !== 0) throw new OrchError(`git fetch ${remote} ${base}: ${r.err.split('\n')[0]}`);
  return git(['rev-parse', `refs/remotes/${remote}/${base}`], root);
}

/**
 * Pushes the task branch so that the remote holds exactly `sha`. `expected` is the sha the remote branch must have
 * now (null: it must not exist): anything else means someone else pushed, and nothing is overwritten.
 */
export function pushExact(cwd, root, remote, branch, sha, expected) {
  const now = remoteSha(root, remote, branch);
  if (now === sha) return 'already there';
  if (now !== expected) {
    throw new OrchError(`the remote branch ${branch} is at ${now ? now.slice(0, 9) : '(missing)'}, not ${expected ? expected.slice(0, 9) : '(new)'} as orch left it: `
      + 'someone else pushed to it. Nothing was overwritten: look at those commits, then adopt them (a new round) or park the task');
  }
  const r = git(['push', '-q', `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`, remote, `${sha}:refs/heads/${branch}`], cwd, { allowFail: true });
  if (r.code !== 0) throw new OrchError(`git push ${branch}: ${r.err.split('\n')[0]}`);
  const after = remoteSha(root, remote, branch);
  if (after !== sha) throw new OrchError(`after the push the remote branch ${branch} is at ${after?.slice(0, 9) ?? '(missing)'}, not ${sha.slice(0, 9)}`);
  return 'pushed';
}

const PR_FIELDS = 'number,url,state,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,isDraft';

export function prView(root, ref) {
  const r = gh(['pr', 'view', String(ref), '--json', PR_FIELDS], root, { allowFail: true });
  if (r.code !== 0) return null;
  return JSON.parse(r.out);
}

const pause = s => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

function openPr(root, branch, base) {
  const open = JSON.parse(gh(['pr', 'list', '--head', branch, '--base', base, '--state', 'open', '--json', 'number'], root).out || '[]');
  if (open.length > 1) throw new OrchError(`${open.length} open PRs from ${branch} into ${base}: close the extra ones`);
  return open.length ? prView(root, open[0].number) : null;
}

/**
 * The open PR from `branch` into `base`, or a new one. A create that fails (GitHub may not see a just-pushed branch
 * yet, or the answer is lost) is retried after a pause, and before each retry the PR is looked up again: it may have
 * been made after all, and a second one must never be opened.
 */
export function ensurePr(root, { branch, base, title, body }) {
  const found = openPr(root, branch, base);
  if (found) return { ...found, created: false };
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      pause(3 * attempt);
      const late = openPr(root, branch, base);
      if (late) return { ...late, created: true };
    }
    const c = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], root, { allowFail: true });
    const url = c.out.split('\n').find(l => /^https:\/\/\S+\/pull\/\d+/.test(l));
    if (c.code === 0 && url) return { ...prView(root, url), created: true };
    last = c.reason;
  }
  throw new OrchError(`gh pr create failed 3 times: ${last}. The branch is pushed; run orch push again`);
}

/** A commit status on the sha (orch/gate, orch/checker), so the PR shows what orch verified. Best effort. */
export function postStatus(root, sha, context, state, description) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root, { allowFail: true }).out;
  if (!repo) return false;
  return gh(['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`,
    '-f', `description=${String(description).slice(0, 140)}`], root, { allowFail: true }).code === 0;
}

/**
 * Merges the PR with a merge commit, only if its head is still `sha` (GitHub refuses otherwise), and returns the
 * merge commit with the base and head GitHub reports after it. `--match-head-commit` binds the head only: the base
 * can change between the last look and the merge, and only the caller's check afterwards can see it (not undo it). A PR already merged at that head (a merge that ran before an interruption) is returned as is.
 */
// A refusal that GitHub confirmed: nothing was merged (the caller may close its "merging" intent).
const notMerged = message => Object.assign(new OrchError(message), { notMerged: true });

export function mergePr(root, number, sha, { base, subject, body }) {
  let pr = prView(root, number);
  if (!pr) throw new OrchError(`PR #${number} not found`);
  if (base && pr.baseRefName !== base) throw notMerged(`PR #${number} targets ${pr.baseRefName}, not ${base}: nothing was merged`);
  if (pr.state === 'MERGED') {
    if (pr.headRefOid !== sha) throw new OrchError(`PR #${number} was merged at ${pr.headRefOid.slice(0, 9)}, not at the verified ${sha.slice(0, 9)}`);
    return { merge: pr.mergeCommit?.oid, already: true, url: pr.url, mergedBase: pr.baseRefName, mergedHead: pr.headRefOid };
  }
  if (pr.state !== 'OPEN') throw notMerged(`PR #${number} is ${pr.state.toLowerCase()}: nothing was merged`);
  if (pr.headRefOid !== sha) throw notMerged(`PR #${number} head is ${pr.headRefOid.slice(0, 9)}, not the verified ${sha.slice(0, 9)}: nothing was merged`);
  const r = gh(['pr', 'merge', String(number), '--merge', '--match-head-commit', sha, '--subject', subject, '--body', body], root, { allowFail: true });
  pr = prView(root, number); // the answer of the merge command can be lost; the PR's state is the truth
  // Not merged is only certain when GitHub answered and the merge command failed. An unreadable state, or a merge
  // accepted but not done yet (a merge queue, auto-merge), may still end merged: the next orch finish looks again.
  if (!pr) throw new OrchError(`gh pr merge #${number}: ${r.code === 0 ? 'accepted' : r.reason}, then the PR could not be read: it may be merged. Run orch finish again (it checks first)`);
  if (pr.state !== 'MERGED' && r.code === 0) throw new OrchError(`gh pr merge #${number} was accepted but the PR is ${pr.state.toLowerCase()} (a merge queue or auto-merge?): run orch finish again once GitHub has merged it`);
  // A PR already in a merge queue may make gh fail although GitHub will merge it: not a refusal.
  if (pr.state !== 'MERGED' && /queue/i.test(r.reason ?? '')) throw new OrchError(`gh pr merge #${number}: ${r.reason}: it may still be merged from the queue. Run orch finish again later`);
  if (pr.state !== 'MERGED') throw notMerged(`gh pr merge #${number}: ${r.reason}. Nothing was merged`);
  // The merge happened: report what GitHub merged (base and head), the caller refuses to treat a mismatch as success.
  return { merge: pr.mergeCommit?.oid, already: false, url: pr.url, mergedBase: pr.baseRefName, mergedHead: pr.headRefOid };
}
