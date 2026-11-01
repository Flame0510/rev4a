// Garbage collection of command artifact scopes (see ARTIFACTS.md). A scope is deleted only when it is proven to
// belong to a run that no longer needs it, and nothing uses it:
//   - its run is merged (and finished): everything goes, successful and failed attempts alike;
//   - its run is open and the scope is from an earlier round (the last failed round stays for diagnosis);
//   - its run is parked or set aside by a split for longer than artifacts.keepDays.
// The temporary folder of a run (run-<id>, the TMPDIR its sub-agents' briefs assign) follows its run the same way, except
// that an open run keeps it whatever the round. sweepTemp is the opt-in backstop for what still lands in the system
// temporary folder (artifacts.tmpSweep).
// A scope is attributed to a run by the ORCH_RUN label orch records in its receipt, or by its working directory (the
// run's worktree; receipts of this release only). Scopes of older releases (no ownership proof), interrupted commands
// (they need a diagnosis) and the main checkout are only listed, and deleted on the owner's explicit request. A scope
// whose owner process lives or (Linux) that a process still uses is never deleted.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function bytes(p) {
  let s;
  try { s = fs.lstatSync(p); } catch { return 0; }
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const f of fs.readdirSync(p)) n += bytes(path.join(p, f));
  return n;
}

// The run a scope belongs to: its recorded label, or the run worktree it ran in (also a set-aside worktree).
export function scopeRun(receipt, worktreeRoot) {
  const label = String(receipt.run ?? '').match(/^(\S+) r(\d+)$/);
  if (label) return { id: label[1].toUpperCase(), round: Number(label[2]) };
  const cwd = String(receipt.cwd ?? '');
  const rel = worktreeRoot ? path.relative(worktreeRoot, cwd) : '';
  // A worktree a split set aside (orch-<id>-before-split-<time>) belongs to that earlier run, not to a new one.
  const aside = !rel.startsWith('..') && rel.match(/^orch-([^/]+?)-before-split-\d+(?:-\d+)?(?:\/|$)/);
  if (aside) return { id: aside[1].toUpperCase(), round: null, setAside: true };
  const m = !rel.startsWith('..') && rel.match(/^orch-([^/]+?)(?:-before-split-\d+(?:-\d+)?)?(?:\/|$)/);
  return m ? { id: m[1].toUpperCase(), round: null } : null;
}

// The scopes some live process uses (Linux): one pass over /proc for all of them, by the ORCH_ARTIFACTS_DIR marker a
// command inherits, a TMPDIR that points inside one, and working directories and open files under the artifacts dir. null when /proc cannot be read
// with certainty: every scope then counts as in use.
export function referencedScopes(artifactsDir) {
  if (process.platform !== 'linux') return new Set();
  const base = fs.realpathSync(artifactsDir);
  const used = new Set();
  const add = p => { if (p === base || !p.startsWith(`${base}/`)) return; used.add(path.join(base, p.slice(base.length + 1).split('/')[0])); };
  try {
    for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
      const dir = `/proc/${pid}`;
      try {
        // A non-root user sees only its own processes (the commands run as this user; others are not readable). Root
        // reads every process, including a command that dropped to another user, and skips only what it cannot read.
        if (process.getuid && process.getuid() !== 0 && fs.statSync(dir).uid !== process.getuid()) continue;
        for (const v of fs.readFileSync(`${dir}/environ`).toString().split('\0')) {
          const m = v.match(/^(?:ORCH_ARTIFACTS_DIR|TMPDIR|TMP|TEMP)=(.*)$/s);
          if (m) add(m[1]);
        }
        for (const f of ['cwd', ...fs.readdirSync(`${dir}/fd`).map(x => `fd/${x}`)]) {
          try { add(fs.readlinkSync(`${dir}/${f}`)); } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) return null; }
        }
      } catch (e) {
        if (e.code === 'EACCES' && process.getuid?.() === 0) continue; // root without ptrace rights in a container
        if (!['ENOENT', 'ESRCH'].includes(e.code)) return null;
      }
    }
  } catch { return null; }
  return used;
}

/**
 * What to do with every scope. runs: id -> { phase, round, finishPending, keepFrom (ms: start of the previous round),
 * startedAt (ms: this run's start), parkedAt (ms), hold (bool: kept whatever its age, e.g. an unsafe merge awaiting the
 * owner) } for runs in runs/; archived: id -> ms when a run of that id was set aside by a split. only: an id, to plan
 * that run's scopes alone. unowned: the owner asked to delete unowned scopes too (they are then inspected). Returns [{ scope, receipt, run, busy, action: 'delete'|'keep'|'unowned', why }].
 */
export function planGc({ artifactsDir, worktreeRoot, runs, archived, keepDays, now = Date.now(), only = null, unowned = false }) {
  if (!fs.existsSync(artifactsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(artifactsDir).filter(n => n.startsWith('command-') || n.startsWith('run-'))) {
    const scope = path.join(artifactsDir, name);
    if (name.startsWith('run-')) {
      const id = name.slice(4).toUpperCase();
      if (only && id !== only) continue;
      const st = runs[id];
      const entry = (action, why) => ({ scope, receipt: null, run: { id, round: null, temp: true }, busy: false, action, why });
      const expired = at => now - at > keepDays * DAY;
      if (!st) out.push(entry(archived[id] ? (expired(archived[id]) ? 'delete' : 'keep') : 'unowned', `${id}: temporary folder of a run set aside or gone`));
      else if (st.hold) out.push(entry('keep', `${id}: waits for the owner`));
      else if (st.phase === 'merged' && !st.finishPending?.length) out.push(entry('delete', `${id} is merged`));
      else if (st.phase === 'parked') out.push(entry(st.parkedAt && expired(st.parkedAt) ? 'delete' : 'keep', `${id} parked`));
      else out.push(entry('keep', `${id}: temporary folder of an open run`));
      continue;
    }
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(scope, 'receipt.json'), 'utf8')); } catch { receipt = null; }
    if (!receipt) { if (!only) out.push({ scope, receipt, run: null, busy: false, action: 'unowned', why: 'no readable receipt' }); continue; }
    // A receipt without the run field was written by an older release: no ownership proof, never adopted.
    const run = 'run' in receipt ? scopeRun(receipt, worktreeRoot) : null;
    if (only && run?.id !== only) continue;
    const owner = alive(receipt.ownerPid);
    const entry = (action, why) => ({ scope, receipt, run, busy: owner, action, why });
    if (!('run' in receipt)) { out.push(entry('unowned', 'older release: no ownership proof')); continue; }
    if (!receipt.finishedAt) { out.push(entry(owner ? 'keep' : 'unowned', owner ? 'running' : 'interrupted: needs diagnosis')); continue; }
    if (!run) { out.push(entry('unowned', 'not attributed to a run')); continue; }
    const at = Date.parse(receipt.finishedAt) || 0;
    const st = runs[run.id];
    const setAside = id => (archived[id] ? (now - archived[id] > keepDays * DAY ? 'delete' : 'keep') : 'unowned');
    // A scope older than this run's start belongs to an earlier run of the same id (set aside by a split).
    if (!st || run.setAside || (st.startedAt && at < st.startedAt - 60_000)) { out.push(entry(setAside(run.id), `${run.id}: an earlier run, set aside`)); continue; }
    if (st.hold) { out.push(entry('keep', `${run.id}: waits for the owner`)); continue; }
    if (st.phase === 'merged' && !st.finishPending?.length) { out.push(entry('delete', `${run.id} is merged`)); continue; }
    if (st.phase === 'parked') { out.push(entry(st.parkedAt && now - st.parkedAt > keepDays * DAY ? 'delete' : 'keep', `${run.id} parked`)); continue; }
    // The current round and the one before it (the last failed attempt, for diagnosis) stay.
    const earlier = run.round !== null ? run.round < st.round - 1 : at < st.keepFrom;
    out.push(entry(earlier ? 'delete' : 'keep', earlier ? `${run.id}: a round before the last two` : `${run.id}: one of its last two rounds`));
  }
  // Process inspection once, and only when something would be deleted.
  if (out.some(x => !x.busy && (x.action === 'delete' || (unowned && x.action === 'unowned')))) {
    const used = referencedScopes(artifactsDir);
    for (const x of out) if (used === null || used.has(path.join(fs.realpathSync(artifactsDir), path.basename(x.scope)))) x.busy = true;
  }
  for (const x of out) if (x.busy && x.action === 'delete') Object.assign(x, { action: 'keep', why: 'still in use' });
  return out;
}

/** Deletes the planned scopes; returns { deleted, freed }. */
export function applyGc(plan, { unowned = false, max = Infinity } = {}) {
  let deleted = 0; let freed = 0;
  for (const x of plan) {
    if (deleted >= max) break;
    const ok = x.action === 'delete' || (unowned && x.action === 'unowned' && (x.receipt || x.run?.temp) && !x.busy);
    if (!ok) continue;
    const n = bytes(x.scope);
    fs.rmSync(x.scope, { recursive: true, force: true });
    deleted++; freed += n;
  }
  return { deleted, freed };
}

export { bytes as scopeBytes };

// Names in the system temporary folder that belong to the system or to long-lived sessions, never swept.
const SYSTEM_TEMP = /^(?:\.|systemd-private-|snap-private-tmp$|tmux-|ssh-|pulse-|krb5cc|hsperfdata_|lost\+found$)/;
const nameMatch = (name, pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

// Whether anything in the tree changed since `since` (ms), by modification and change time; stops at the first one.
// A socket or pipe (a live server may own it), another filesystem (a mount) or a tree larger than `budget` entries also
// counts as recent: it is left alone rather than judged.
function changedSince(p, since, dev, budget = { n: 50_000 }) {
  let s;
  try { s = fs.lstatSync(p); } catch { return false; }
  if (Math.max(s.mtimeMs, s.ctimeMs) >= since || --budget.n < 0 || s.dev !== dev || s.isSocket() || s.isFIFO()) return true;
  if (!s.isDirectory()) return false;
  let names;
  try { names = fs.readdirSync(p); } catch { return true; }
  return names.some(n => changedSince(path.join(p, n), since, dev, budget));
}

// The top-level entries of `base` that any live process uses: its working and root directory, open files, mapped files,
// absolute paths in its arguments and its temporary-folder variables, plus bound unix sockets. Every process must be
// readable: when one is not (another user's, without the right to inspect it), null — nothing can be ruled out.
function entriesInUse(base) {
  const used = new Set();
  const add = p => { if (typeof p === 'string' && p.startsWith(`${base}/`)) used.add(path.join(base, p.slice(base.length + 1).split('/')[0])); };
  const gone = e => ['ENOENT', 'ESRCH'].includes(e.code);
  try {
    for (const line of fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)) add(line.trim().split(/\s+/)[7]);
    for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
      const dir = `/proc/${pid}`;
      try {
        for (const l of ['cwd', 'root']) { try { add(fs.readlinkSync(`${dir}/${l}`)); } catch (e) { if (!gone(e)) throw e; } }
        for (const fd of fs.readdirSync(`${dir}/fd`)) { try { add(fs.readlinkSync(`${dir}/fd/${fd}`)); } catch (e) { if (!gone(e)) throw e; } }
        for (const line of fs.readFileSync(`${dir}/maps`, 'utf8').split('\n')) add(line.slice(line.indexOf('/')).replace(/ \(deleted\)$/, ''));
        for (const a of fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0')) { add(a); add(a.slice(a.indexOf('=') + 1)); }
        for (const v of fs.readFileSync(`${dir}/environ`, 'utf8').split('\0')) add(v.slice(v.indexOf('=') + 1));
      } catch (e) { if (!gone(e)) return null; }
    }
  } catch { return null; }
  return used;
}

/**
 * The opt-in backstop for the system temporary folder (artifacts.tmpSweep): the top-level entries of `dir` that are
 * regular files or real folders on its own filesystem (never links, sockets, devices or mounts), belong to this user (any
 * owner when running as root), are not system names or in `keep`, hold no socket or pipe, have nothing modified or
 * changed inside for `days` days, and that no process uses. Linux only, and only when every process can be inspected:
 * otherwise nothing is swept. `protect`: folders (the checkout, worktrees, artifacts) never touched — an entry holding
 * one is skipped, and a `dir` inside one sweeps nothing. Plans only unless `apply`; then deletes at most `max`
 * entries, measures only what it deletes and stops after `budgetMs`. Returns { entries: [{ path, bytes }], deleted, freed, blocked? }.
 */
export function sweepTemp({ dir, days, keep = [], protect = [], apply = false, max = 200, budgetMs = 20_000, now = Date.now() }) {
  const result = { entries: [], deleted: 0, freed: 0 };
  if (process.platform !== 'linux' || !(days >= 1)) return result;
  let base; let baseDev;
  try { base = fs.realpathSync(dir); baseDev = fs.statSync(base).dev; } catch { return result; }
  if (base === '/') return result;
  const guarded = new Set();
  for (const p of protect) {
    let real;
    try { real = fs.realpathSync(p); } catch { continue; }
    if (real === base || base.startsWith(`${real}/`)) return { ...result, blocked: `${base} is inside ${real}` };
    if (real.startsWith(`${base}/`)) guarded.add(path.join(base, real.slice(base.length + 1).split('/')[0]));
  }
  const t0 = Date.now();
  const since = now - days * 86_400_000;
  const uid = process.getuid?.();
  const candidates = [];
  for (const name of fs.readdirSync(base)) {
    if (SYSTEM_TEMP.test(name) || keep.some(k => nameMatch(name, k))) continue;
    const p = path.join(base, name);
    let s;
    try { s = fs.lstatSync(p); } catch { continue; }
    if (!(s.isFile() || s.isDirectory()) || s.dev !== baseDev || guarded.has(p) || (uid !== 0 && s.uid !== uid)) continue;
    if (Date.now() - t0 > budgetMs) break;
    if (!changedSince(p, since, baseDev)) candidates.push(p);
  }
  if (!candidates.length) return result;
  const used = entriesInUse(base);
  if (used === null) return { ...result, blocked: 'not every process can be inspected: run the keeper as the user that runs every process, or as root with CAP_SYS_PTRACE (a container runs without it by default)' };
  for (const p of candidates) {
    if (used.has(p)) continue;
    if (!apply) { result.entries.push({ path: p, bytes: bytes(p) }); continue; }
    if (result.deleted >= max || Date.now() - t0 > budgetMs) break;
    const n = bytes(p);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { continue; /* left for the next pass */ }
    result.entries.push({ path: p, bytes: n }); result.deleted++; result.freed += n;
  }
  return result;
}
