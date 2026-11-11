// Detached gates retain the run lock when a coordinator or its attaching CLI exits.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, runDir } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { deadReason, holdTransferredLock, processIdentity, sleep, transferRunLock, withRunLock } from './runlock.mjs';
import { minutes, OrchError, readJson, writeAtomic, writeJson } from './util.mjs';

const orchPath = fileURLToPath(new URL('../orch.mjs', import.meta.url));
const jobFile = (root, id) => path.join(runDir(root, id), 'gate-job.json');
export const gateJob = (root, id) => readJson(jobFile(root, id), null);
export const liveGate = job => job && !job.done && !deadReason(job) ? job : null;
// The launch identity stays fixed, including on hosts without /proc. Lock handoff uses a separate token.
const jobToken = job => `${job.pid}-${job.startedAt}`;
const sameJob = (a, b) => a && b && a.pid === b.pid && a.startedAt === b.startedAt;
const resultFile = (root, id, job) => path.join(runDir(root, id), `gate-job-${jobToken(job)}.json`);
const savedJob = (root, id, job) => readJson(resultFile(root, id, job), null);
function saveReceipt(root, id, job) {
  writeJson(resultFile(root, id, job), job);
  const dir = runDir(root, id);
  const files = fs.readdirSync(dir).filter(name => /^gate-job-\d+-[\d.]+\.json$/.test(name))
    .map(name => ({ name, time: Number(name.match(/^gate-job-\d+-([\d.]+)\.json$/)[1]) }))
    .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  // An attacher may still wait for an older job's receipt (up to gateWaitSec): beyond the newest 3, only receipts
  // of jobs started more than a day ago are removed.
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const { name, time } of files.slice(3)) if (time < dayAgo) fs.rmSync(path.join(dir, name), { force: true });
}

// Called only under the run lock, after a gate actually wrote a result. Saved receipts remain readable by
// their original attachers even after collection or supersession; new callers use only the canonical job.
function supersede(root, id, except = null) {
  const previous = gateJob(root, id);
  if (previous && !sameJob(previous, except)) {
    const done = { ...previous, collected: true, superseded: true };
    writeJson(jobFile(root, id), done);
    if (previous.done) saveReceipt(root, id, done);
  }
  for (const name of fs.readdirSync(runDir(root, id)).filter(name => /^gate-job-\d+-[\d.]+\.json$/.test(name))) {
    const file = path.join(runDir(root, id), name);
    const old = readJson(file, null);
    if (old && !sameJob(old, except) && !old.superseded) writeJson(file, { ...old, collected: true, superseded: true });
  }
}

function collect(root, id, job) {
  const done = { ...job, ...savedJob(root, id, job), collected: true };
  saveReceipt(root, id, done);
  if (sameJob(job, gateJob(root, id))) writeJson(jobFile(root, id), done);
}

async function foreground(root, id, args, run) {
  const result = await run(root, args);
  if (result && !result.discarded) supersede(root, id);
  return result;
}

function receipt(root, id, job, out) {
  const text = job.text ?? fs.readFileSync(path.join(runDir(root, id), `gate-r${job.round}.txt`), 'utf8').trimEnd();
  out(text, job.next);
  process.exitCode = job.exitCode;
}

async function attach(root, id, job, cfg, out) {
  const t0 = Date.now();
  for (;;) {
    const latest = gateJob(root, id);
    const saved = savedJob(root, id, job);
    const current = saved ?? (sameJob(job, latest) ? latest : job);
    if (current.stopped) return { retry: true };
    if (!sameJob(job, latest) && !saved) {
      throw new OrchError(`INFRA  result of gate job ${jobToken(job)} is no longer retained; orch gate ${id} attaches again`, 3);
    }
    if (current.done) {
      // Keep this job's receipt: another gate of the same round may already be replacing gate-r<n>.txt.
      // Marking it collected is best effort: a command holding the run meanwhile never hides a finished verdict.
      try {
        await withRunLock(root, id, { cmd: `gate collect of ${id}`, waitSec: Math.min(5, cfg.limits.runLockWaitSec),
          whenBusy: () => sameJob(current, gateJob(root, id)) ? null : { skipCollection: true } }, () => collect(root, id, current));
      } catch (e) { if (!(e instanceof OrchError) || e.exitCode !== 4) throw e; }
      receipt(root, id, current, out);
      return;
    }
    const reason = deadReason(current);
    if (reason) {
      // Re-enter through the same locked launch path; another attacher may already be recovering it.
      return { retry: true };
    }
    if (Date.now() - t0 >= cfg.limits.gateWaitSec * 1000) {
      out(`gate ${id} round ${job.round} still running (since ${job.at}, ${minutes(Date.now() - Date.parse(job.at))}): orch gate ${id} attaches again`);
      process.exitCode = 4;
      return;
    }
    await sleep(100);
  }
}

export async function runGateCommand(root, args, { validate, run, out }) {
  const id = args.pos[0]?.toUpperCase();
  if (!id) throw new OrchError('missing task id');
  const cfg = loadConfig(root);
  if (!fs.existsSync(runDir(root, id))) validate(root, id, cfg);
  const file = jobFile(root, id);
  const cmd = `gate job of ${id}`;
  if (args.flags.job) {
    const token = process.env.ORCH_GATE_LOCK_TOKEN;
    if (!token) throw new OrchError('--job is internal: use orch gate <id>');
    // The launching command hands the run lock to this process while it still holds it (never adopted here): if
    // the launcher died first, the lock never names this job and the job stops without running a gate.
    return holdTransferredLock(root, id, token, async () => {
      const job = gateJob(root, id);
      if (!job || job.pid !== process.pid || job.done || job.lockToken !== token) throw new OrchError('gate job ownership changed', 3);
      writeJson(file, job);
      writeAtomic(`${file}.ready-${token}`, token); // per job: a later job never overwrites this acknowledgement
      let result;
      try {
        const st = validate(root, id, cfg);
        if (st.round !== job.round || st.phase !== job.phase) throw new OrchError('round or phase changed before the gate started', 3);
        result = await run(root, args); // same foreground output in the job log
      } catch (e) {
        const text = `INFRA  gate job stopped without a result (${e.message})`;
        console.log(text);
        result = { text, next: `next: inspect the job log; retry orch gate ${id}`, exitCode: 3, discarded: true };
        process.exitCode = 3;
      }
      if (sameJob(job, gateJob(root, id))) {
        if (!result.discarded) supersede(root, id, job);
        const done = { ...job, done: true, ...result, resultPhase: loadState(root, id).phase, collected: false };
        saveReceipt(root, id, done);
        writeJson(file, done);
      }
    });
  }
  if (process.env.ORCH_GATE_FOREGROUND === '1') {
    return withRunLock(root, id, { cmd: 'gate (foreground)', waitSec: cfg.limits.runLockWaitSec }, () => foreground(root, id, args, run));
  }
  for (;;) {
    let job = gateJob(root, id);
    if (!liveGate(job)) {
      const existing = () => {
        const j = gateJob(root, id);
        return liveGate(j) ? { job: j } : null;
      };
      const launched = await withRunLock(root, id, { cmd: `gate launch of ${id}`, waitSec: cfg.limits.runLockWaitSec, whenBusy: existing }, async lock => {
        const found = existing();
        if (found) return found;
        const previous = gateJob(root, id);
        let st;
        try { st = validate(root, id, cfg); }
        catch (e) {
          if (previous?.done && !previous.collected) collect(root, id, previous);
          throw e;
        }
        if (previous?.done && !previous.collected) {
          collect(root, id, previous);
          if (previous.round === st.round && previous.resultPhase === st.phase) return { receipt: previous };
        }
        if (previous && !previous.done) {
          const reason = deadReason(previous) ?? 'ownership lost';
          saveReceipt(root, id, { ...previous, stopped: reason, collected: true });
          out(`INFRA  previous gate job of round ${previous.round} stopped without a result (${reason})`);
        }
        fs.mkdirSync(path.join(runDir(root, id), 'logs'), { recursive: true });
        const fd = fs.openSync(path.join(runDir(root, id), 'logs', `gate-r${st.round}-job.log`), 'a');
        let child;
        let spawnError = null;
        const childToken = randomUUID();
        try {
          child = spawn(process.execPath, [orchPath, 'gate', id, '--job'], {
            cwd: root, detached: true, stdio: ['ignore', fd, fd],
            env: { ...process.env, ORCH_RUN: `${id} r${st.round}`, ORCH_GATE_LOCK_TOKEN: childToken },
          });
        } catch (e) { spawnError = e; } finally { fs.closeSync(fd); }
        child?.on('error', e => { spawnError = e; });
        child?.unref();
        job = { ...(child?.pid ? processIdentity(child.pid) : { pid: null, startedAt: Date.now(), bootId: null }), round: st.round, phase: st.phase, at: new Date().toISOString(), lockToken: childToken };
        job.token = jobToken(job);
        writeJson(file, job);
        // Ownership moves to the child while this process holds the lock and is alive: no other command can
        // judge the lock stale during the handoff. The child then acknowledges.
        if (child?.pid && !spawnError) transferRunLock(lock.lockDir, child.pid, childToken, cmd);
        // This launcher follows ITS job only: its own acknowledgement, or its own receipt when the job already
        // finished (and another caller may have collected it and launched a later job meanwhile).
        const ready = `${file}.ready-${childToken}`;
        const started = () => fs.existsSync(ready) || Boolean(savedJob(root, id, job));
        const until = Date.now() + 10_000;
        while (!spawnError && Date.now() < until) {
          if (started()) { fs.rmSync(ready, { force: true }); return { job }; }
          if (!child.pid || deadReason(job)) break;
          await sleep(25);
        }
        if (started()) { fs.rmSync(ready, { force: true }); return { job }; }
        if (child?.pid) {
          child.ref(); // keep the fallback CLI alive until the killed child has been reaped
          if (!deadReason(job)) {
            try { process.kill(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          }
          // Wait for exit before the foreground fallback can take over its stale lock.
          await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('close', resolve); });
        }
        console.error(`WARN  detached gate could not acquire its lock within 10 s${spawnError ? ` (${spawnError.message})` : ''}; running in the foreground`);
        return { fallback: true };
      });
      if (launched.receipt) return receipt(root, id, launched.receipt, out);
      if (launched.fallback) {
        return withRunLock(root, id, { cmd: 'gate (foreground fallback)', waitSec: cfg.limits.runLockWaitSec }, async () => {
          const result = await foreground(root, id, args, run);
          const identity = job.pid ? job : { ...job, ...processIdentity() };
          const done = { ...identity, token: jobToken(identity), done: true, ...result, resultPhase: loadState(root, id).phase, collected: true };
          saveReceipt(root, id, done);
          writeJson(file, done);
        });
      }
      job = launched.job;
    }
    const result = await attach(root, id, job, cfg, out);
    if (!result?.retry) return;
  }
}
