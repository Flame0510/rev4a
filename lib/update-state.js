'use strict';
/**
 * State of a Rev4a self-update, shared by the CLI (`rev4a update` writes it) and the
 * server (the status route and the mutation guard read it).
 *
 * CommonJS so both sides apply one rule. The state lives in `<data>/update-state.json`,
 * next to `update.log`; it is a hint for the UI, never a lock — nothing here changes how
 * the update installs or builds.
 *
 * Phases: starting -> installing -> building -> restarting -> done, or failed at any point.
 * An update is *in progress* in every phase but done and failed.
 *
 * Rules, applied when the state is read (`readUpdate`):
 *  - older than 30 minutes (STALE_MS since the last write), or written more than 5 minutes
 *    in the future (a clock that stepped back): not an update any more, null;
 *  - the process that writes it (`pid`) is gone while the phase is not done or restarting:
 *    the updater died (a crash, a kill): failed. `restarting` is exempt because the
 *    updater exits on purpose once it has asked for the restart;
 *  - `restarting` and the reading *server* (not any process) started after the state was last written: that
 *    server is the restarted one. It marks the update done only when it runs the version
 *    the update was installing (`to`); another version is a failure. The running version
 *    comes from server.js (REV4A_RUNNING_VERSION, read once when the process started),
 *    never from package.json on disk, which npm replaces before the build and restart.
 *
 * One update at a time: `claimUpdate` checks and writes `starting` in one synchronous
 * step, with a unique claim token, so two simultaneous requests cannot both start one.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = 'update-state.json';
const STALE_MS = 30 * 60 * 1000;
const PHASES = ['starting', 'installing', 'building', 'restarting', 'done', 'failed'];
const MAX_ERROR = 600;
const FUTURE_MS = 5 * 60 * 1000;
/**
 * A restart that has not happened after this long will not: the supervisor missed the
 * flag. The state fails, so the screen and the write guard let go of the old server.
 */
const RESTART_MS = 5 * 60 * 1000;
/** Env var through which the dashboard hands its claim to the `rev4a update` it spawns. */
const CLAIM_ENV = 'REV4A_UPDATE_CLAIM';

const stateFile = (dataDir) => path.join(dataDir, STATE_FILE);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but is not ours.
    return Boolean(e && e.code === 'EPERM');
  }
}

/** The raw state on disk, or null when missing or malformed. */
function readRaw(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !PHASES.includes(parsed.phase)) return null;
    if (typeof parsed.updatedAt !== 'number' || typeof parsed.startedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic write: a reader sees the old file or the new one, never half of it. */
function writeRaw(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = stateFile(dataDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    // Best effort: a state that cannot be written must never stop the update itself.
    return false;
  }
}

/**
 * Record a phase. `patch` may carry from, to, error, pid, claim; the rest (startedAt, from, to) is
 * kept from the previous state of the same run. `starting` begins a new run.
 */
function writeUpdate(dataDir, phase, patch = {}, now = Date.now()) {
  const prev = phase === 'starting' ? null : readRaw(dataDir);
  const state = {
    phase,
    from: patch.from ?? (prev && prev.from) ?? null,
    to: patch.to ?? (prev && prev.to) ?? null,
    startedAt: patch.startedAt || (prev && prev.startedAt) || now,
    updatedAt: now,
    pid: patch.pid ?? process.pid,
  };
  const claim = patch.claim ?? (prev && prev.claim);
  if (claim) state.claim = claim;
  if (phase === 'failed') state.error = String(patch.error || 'The update failed.').slice(0, MAX_ERROR);
  return writeRaw(dataDir, state) ? state : null;
}

/**
 * Start an update, or refuse because one is already in progress. The check and the write
 * are synchronous with nothing awaited in between, so within one process two callers
 * cannot both pass. `claim` identifies this caller's run. `inherited` says the claim was
 * made earlier by whoever spawned this process (the dashboard route): then a state
 * carrying that same claim is ours, not a competitor. Returns { ok, state }; `state` is
 * the competing update when refused.
 */
function claimUpdate(dataDir, { from = null, claim, pid, inherited = false, opts = {} } = {}) {
  const cur = currentUpdate(dataDir, opts);
  if (cur && !(inherited && claim && cur.claim === claim)) return { ok: false, state: cur };
  // The updater taking over the dashboard's claim keeps its startedAt: the route's marker
  // in update.log carries it, and the log tail is matched on it.
  const startedAt = inherited && cur ? cur.startedAt : undefined;
  const state = writeUpdate(dataDir, 'starting', { from, pid, claim, startedAt }, opts.now ?? Date.now());
  return { ok: true, state };
}

/**
 * Replace the pid of a claimed run (the dashboard route records its own pid first, then
 * the child's), only while the state on disk still carries that claim: the updater may
 * already have moved on, failed or cleared it, and then it is left alone.
 */
function adoptPid(dataDir, claim, pid) {
  const raw = readRaw(dataDir);
  if (!claim || !raw || raw.claim !== claim) return false;
  return writeRaw(dataDir, { ...raw, pid });
}

/** Mark a claimed run failed, only while the state on disk still carries that claim. */
function failClaimed(dataDir, claim, error, now = Date.now()) {
  const raw = readRaw(dataDir);
  if (!claim || !raw || raw.claim !== claim) return false;
  return writeRaw(dataDir, { ...raw, phase: 'failed', updatedAt: now, error: String(error || 'The update failed.').slice(0, MAX_ERROR) });
}

/** Lines longer than this are cut before redaction: it keeps the regexes cheap on a long blob. */
const MAX_LINE = 500;
/** Name parts that make the value after `NAME=` / `NAME:` a secret anywhere in the name… */
const SECRET_PARTS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'apikey', 'credential', 'credentials', 'cookie', 'authorization']);
/** …and parts that do only as the last one (`ssh_key`, `basic_auth`), so `keyv` or `author` stay. */
const SECRET_LAST = new Set(['key', 'auth', 'pass']);

function isSecretName(name) {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  return parts.some((p) => SECRET_PARTS.has(p)) || SECRET_LAST.has(parts[parts.length - 1]);
}

/**
 * Remove secrets from a line of update output before it is shown to the browser: the value
 * after a secret-looking name (`NAME=value`, `NAME: rest of line`, quoted JSON keys too),
 * `Bearer` / `Basic` values, long `token …` values, `--password …`-style flags, npm,
 * `sk-`, GitHub, GitLab, Slack, AWS and Google keys, JWTs, and credentials in URLs.
 * Lines are cut at MAX_LINE characters first.
 */
function redact(text) {
  let line = String(text);
  if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…`;
  return line
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+(?!\[redacted\])\S+/gi, '$1 [redacted]')
    .replace(/\b(token)\s+[A-Za-z0-9_.~+/=-]{16,}/gi, '$1 [redacted]')
    .replace(/(?<!\S)(--?[A-Za-z-]*(?:password|token|secret|key)[A-Za-z-]*)(\s+)(?!\[redacted\])\S+/gi, '$1$2[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}/g, '[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{10,}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(
      // A name starts at a boundary (the lookbehind keeps this linear on long runs).
      /(?<![A-Za-z0-9_.])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*([=:])\s*)("[^"]*"|'[^']*'|\S.*)?/g,
      (m, q, name, sep, op, value) => {
        if (!value) return m;
        // Not a secret name: keep it, and look for one further along the line.
        if (!isSecretName(name)) return `${q}${name}${q}${sep}${redact(value)}`;
        if (value[0] === '"' || value[0] === "'") return `${q}${name}${q}${sep}[redacted]`;
        // `NAME: …` and `NAME= …` take the rest of the line (multi-word values);
        // `NAME=value` one word.
        if (op === ':' || /\s$/.test(sep)) return `${q}${name}${q}${sep}[redacted]`;
        const rest = value.replace(/^\S+/, '');
        return `${q}${name}${q}${sep}[redacted]${redact(rest)}`;
      },
    );
}

function clearUpdate(dataDir) {
  try { fs.unlinkSync(stateFile(dataDir)); } catch { /* already gone */ }
}

/**
 * The effective state, or null when there is none worth showing (missing, malformed or
 * stale). May write: a dead updater becomes `failed`, a restarted server marks `done`.
 *
 * opts: now, isAlive(pid), startedAt (when the reading process started; defaults to this
 * process), runningVersion, isServer (defaults to REV4A_SERVER_PID being this process's
 * pid, which server.js sets). Only the server resolves `restarting` (done, or failed on the
 * wrong version); any other reader, such as a `rev4a update` started later from a shell,
 * leaves it alone and applies only the 5-minute rule.
 */
function readUpdate(dataDir, opts = {}) {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidAlive;
  const envStarted = Number(process.env.REV4A_STARTED_AT);
  const processStartedAt = opts.startedAt ?? (envStarted > 0 ? envStarted : now - process.uptime() * 1000);
  const runningVersion = opts.runningVersion !== undefined ? opts.runningVersion : (process.env.REV4A_RUNNING_VERSION || null);
  const isServer = opts.isServer ?? process.env.REV4A_SERVER_PID === String(process.pid);
  const state = readRaw(dataDir);
  if (!state) return null;
  if (now - state.updatedAt > STALE_MS) return null;
  if (state.updatedAt - now > FUTURE_MS) return null;
  if (state.phase === 'done' || state.phase === 'failed') return state;
  if (state.phase === 'restarting') {
    if (isServer && processStartedAt > state.updatedAt) {
      if (state.to && runningVersion && runningVersion !== state.to) {
        const wrong = {
          ...state,
          phase: 'failed',
          updatedAt: now,
          error: `Rev4a restarted on ${runningVersion}, not ${state.to}`,
        };
        writeRaw(dataDir, wrong);
        return wrong;
      }
      const done = { ...state, phase: 'done', updatedAt: now };
      writeRaw(dataDir, done);
      return done;
    }
    if (now - state.updatedAt > RESTART_MS) {
      const stuck = {
        ...state,
        phase: 'failed',
        updatedAt: now,
        error: 'Rev4a did not restart within 5 minutes. The new version is installed and runs from the next restart.',
      };
      writeRaw(dataDir, stuck);
      return stuck;
    }
    return state;
  }
  if (!isAlive(state.pid)) {
    const failed = {
      ...state,
      phase: 'failed',
      updatedAt: now,
      error: 'The update process stopped before it finished. See update.log in the Rev4a data directory, or the terminal it was started from.',
    };
    writeRaw(dataDir, failed);
    return failed;
  }
  return state;
}

/** True for a state that is still running. */
const isInProgress = (state) => Boolean(state) && state.phase !== 'done' && state.phase !== 'failed';

/** The state only while an update is in progress, else null. */
function currentUpdate(dataDir, opts) {
  const state = readUpdate(dataDir, opts);
  return isInProgress(state) ? state : null;
}

module.exports = {
  STATE_FILE,
  STALE_MS,
  PHASES,
  stateFile,
  pidAlive,
  writeUpdate,
  clearUpdate,
  claimUpdate,
  adoptPid,
  failClaimed,
  redact,
  CLAIM_ENV,
  FUTURE_MS,
  readUpdate,
  currentUpdate,
  isInProgress,
};
