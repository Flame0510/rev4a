// Per-run exclusion, independent of the project harness lock. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { OrchError, writeJson } from './util.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
let ticks;
export function pidStartTime(pid) {
  try {
    ticks ??= Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout?.trim()) || 100;
    // comm can contain spaces and parentheses; fields after its final ')' start at field 3.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const boot = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    const start = boot * 1000 + Number(fields[19]) * 1000 / ticks;
    return Number.isFinite(start) ? start : null;
  } catch { return null; }
}
export const bootId = () => read('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stat = read(`/proc/${pid}/stat`);
    if (stat && /^[ZX] /.test(stat.slice(stat.lastIndexOf(')') + 2))) return false;
    process.kill(pid, 0); return true;
  } catch (e) { return e.code !== 'ESRCH'; }
}
export function processCommand(pid) {
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    return !result.error && result.status === 0 ? result.stdout.trim() : null;
  } catch { return null; }
}
const helpers = { alive: pidAlive, start: pidStartTime, boot: bootId, hasProc: () => fs.existsSync('/proc/self/stat'), command: processCommand, now: Date.now };
export function processIdentity(pid = process.pid) {
  return { pid, startedAt: pidStartTime(pid) ?? Date.now(), bootId: bootId() };
}
// Injectable process observations make reboot and pid reuse testable on hosts without /proc.
export function deadReason(owner, overrides = {}) {
  const h = { ...helpers, ...overrides };
  if (!owner || !h.alive(owner.pid)) return 'pid is no longer alive';
  if (h.hasProc()) {
    const boot = h.boot();
    if (boot && owner.bootId && boot !== owner.bootId) return 'boot id changed';
    const started = h.start(owner.pid);
    if (started !== null && Number.isFinite(started) && Math.abs(started - owner.startedAt) > 2000) return 'pid was reused';
  } else {
    const command = h.command(owner.pid);
    // A failed/unavailable ps is uncertainty, never proof that a live owner died.
    if (command !== null && !command.includes('orch.mjs')) return 'pid was reused by another program';
  }
  return null;
}

function staleLock(lock, text, observations, reclaiming = false) {
  const owner = parse(text);
  if (Number.isInteger(owner?.pid) && owner.pid > 0) return deadReason(owner, observations);
  if (!reclaiming && fs.existsSync(`${lock}.reclaim`)) return null;
  try { return (observations.now ?? Date.now)() - fs.statSync(lock).mtimeMs > 60_000 ? 'owner record missing' : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function cleanReclaim(lock, observations) {
  const dir = `${lock}.reclaim`;
  const file = path.join(dir, 'owner.json');
  const text = read(file);
  if (staleLock(dir, text, observations) && read(file) === text) fs.rmSync(dir, { recursive: true, force: true });
}

async function reclaim(lock, judged, observations, hooks) {
  await hooks.beforeReclaim?.(lock);
  const dir = `${lock}.reclaim`;
  const file = path.join(dir, 'owner.json');
  const mine = JSON.stringify({ ...processIdentity(), acquiredAt: Date.now(), cmd: 'run lock reclamation', host: os.hostname() });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return;
  }
  fs.writeFileSync(file, mine);
  try {
    await hooks.afterReclaim?.(lock);
    // Live owners never expire. The residual read/remove window requires a reclaimer that crashed
    // inside this section and two others breaking its reclaim lock at the same instant. One coordinator
    // per project makes that practically unreachable; directory locks cannot eliminate that window.
    const current = read(path.join(lock, 'owner.json'));
    if (current === judged && staleLock(lock, current, observations, true)) removeLockDir(lock);
  } finally {
    if (read(file) === mine) fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

// Removing run.lock in place would empty it first (owner.json, then the directory); an acquirer's rename can replace
// an empty directory in that instant, and the removal then fails or races. Move it away whole (only possible while it
// still holds its owner record), then delete the moved copy.
function removeLockDir(lock) {
  const gone = `${lock}.gone-${randomUUID()}`;
  try { fs.renameSync(lock, gone); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  fs.rmSync(gone, { recursive: true, force: true });
}

// The owner record is written before the lock exists: a lock directory is created complete (temp dir + rename),
// so no live acquirer is ever seen without an owner.
function acquireAtomically(lock, mine) {
  const tmp = `${lock}.tmp-${randomUUID()}`;
  fs.mkdirSync(tmp);
  try {
    fs.writeFileSync(path.join(tmp, 'owner.json'), mine);
    fs.renameSync(tmp, lock);
    return true;
  } catch (e) {
    // The lock existed at the rename; it may already be released again. Never re-check here (that check-then-act
    // turned a quick release into a crash): the caller retries acquisition.
    if (['EEXIST', 'ENOTEMPTY'].includes(e.code)) return false;
    if (['EPERM', 'EACCES', 'EISDIR'].includes(e.code) && fs.existsSync(lock)) return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run `action` as the owner of a lock another process transferred to `token` (a detached gate). */
export async function holdTransferredLock(root, id, token, action, waitMs = 10_000) {
  const file = path.join(root, '.orchestrate', 'runs', id.toUpperCase(), 'run.lock', 'owner.json');
  const until = Date.now() + waitMs;
  while (parse(read(file))?.token !== token) {
    if (Date.now() >= until) throw new OrchError('the run lock was never transferred to this gate job', 3);
    await sleep(25);
  }
  try { return await action(); }
  finally { if (parse(read(file))?.token === token) removeLockDir(path.dirname(file)); }
}

/** Hand a held lock to another live process (its identity and token), atomically, while the caller still holds it. */
export function transferRunLock(lockDir, pid, token, cmd) {
  writeJson(path.join(lockDir, 'owner.json'), { ...processIdentity(pid), acquiredAt: Date.now(), cmd, host: os.hostname(), token });
}

export async function withRunLock(root, id, { cmd, waitSec = 30, observations = {}, hooks = {}, whenBusy = null, createRunDirectory = false }, action) {
  if (!Number.isFinite(waitSec) || waitSec < 0) throw new OrchError('limits.runLockWaitSec must be a non-negative number');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new OrchError('invalid run id');
  id = id.toUpperCase();
  let lock = path.join(root, '.orchestrate', 'runs', id, 'run.lock');
  const owner = { ...processIdentity(), acquiredAt: Date.now(), cmd, host: os.hostname(), token: randomUUID() };
  const mine = JSON.stringify(owner, null, 2) + '\n';
  const t0 = Date.now();
  for (;;) {
    // Also recover a reclaimer that died after removing run.lock, before ordinary acquisition succeeds.
    cleanReclaim(lock, observations);
    try {
      if (acquireAtomically(lock, mine)) break;
    } catch (e) {
      if (e.code === 'ENOENT') {
        if (!createRunDirectory) throw new OrchError(`no run for ${id}: \"orch start ${id}\" first`);
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        continue;
      }
      throw e;
    }
    const file = path.join(lock, 'owner.json');
    const judged = read(file); const previous = parse(judged);
    if (staleLock(lock, judged, observations)) {
      // Retry normal acquisition after reclamation or an owner change. A busy reclaimer still obeys the wait limit.
      if (await reclaim(lock, judged, observations, hooks)) continue;
    }
    const attached = await whenBusy?.();
    if (attached) return attached;
    if (Date.now() - t0 >= waitSec * 1000) {
      const holder = parse(read(path.join(`${lock}.reclaim`, 'owner.json'))) ?? previous;
      throw new OrchError(`${id} is busy: ${holder?.cmd ?? 'another command'} (pid ${holder?.pid ?? '?'}, since ${holder?.acquiredAt || holder?.startedAt ? new Date(holder.acquiredAt ?? holder.startedAt).toISOString() : '?'}) holds it; wait and run the command again. If the owner is not an orch process, verify it has stopped using the run, then remove ${lock} and ${lock}.reclaim by hand.`, 4);
    }
    await sleep(Math.min(500, Math.max(1, waitSec * 1000 - (Date.now() - t0))));
  }
  try { return await action({ owner, lockDir: lock, relocate: next => { lock = next; } }); }
  finally {
    if (read(path.join(lock, 'owner.json')) === mine) removeLockDir(lock);
  }
}
