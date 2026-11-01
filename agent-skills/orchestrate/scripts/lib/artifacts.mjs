// Opt-in lifecycle for NEW command-owned temporary files. Never scans legacy /tmp or other runs.
import fs from 'node:fs';
import path from 'node:path';

export const ARTIFACT_DEFAULTS = { enabled: false, minFreeBytes: 0, disposable: [] };

export function validatePolicy(policy) {
  if (typeof policy.enabled !== 'boolean' || !Number.isSafeInteger(policy.minFreeBytes) || policy.minFreeBytes < 0
    || !Array.isArray(policy.disposable)) throw new Error('invalid artifacts policy');
  for (const p of policy.disposable) {
    // Only explicit build/dependency directory names, under a newly allocated temporary scope.
    if (typeof p !== 'string' || !/^(?:[A-Za-z0-9_.-]+|\*)(?:\/(?:[A-Za-z0-9_.-]+|\*))*\/(?:\.next|node_modules)$/.test(p)
      || p.split('/').some(s => s === '.' || s === '..')) throw new Error(`invalid disposable artifact pattern: ${p}`);
  }
}

function directory(p) {
  try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// Never traverse a symlink, including intermediate path segments or links inside a disposable directory.
export function disposablePaths(temp, patterns) {
  if (!directory(temp) || fs.realpathSync(temp) !== path.resolve(temp)) throw new Error('temporary scope is not a real directory');
  const out = new Set();
  function visit(base, parts) {
    if (!parts.length) { out.add(base); return; }
    const [part, ...rest] = parts;
    const names = part === '*' ? fs.readdirSync(base) : [part];
    for (const name of names) {
      const p = path.join(base, name);
      if (directory(p)) visit(p, rest);
    }
  }
  for (const pattern of patterns) visit(temp, pattern.split('/'));
  return [...out].sort().filter((p, i, all) => !all.some((parent, j) => j !== i && p.startsWith(`${parent}${path.sep}`)));
}

function bytes(p) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink()) return s.size;
  return s.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0) : s.size;
}

function writeReceipt(scope, receipt) {
  const file = path.join(scope, 'receipt.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function beginArtifacts(policy, cwd = process.cwd()) {
  validatePolicy(policy);
  if (!policy.enabled) return null;
  const requested = path.resolve(policy.root);
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  if (!directory(requested)) throw new Error('artifact root must not be a symlink');
  const root = fs.realpathSync(requested);
  for (const p of [root, cwd]) {
    const s = fs.statfsSync(p);
    if (s.bavail * s.bsize < policy.minFreeBytes) {
      const e = new Error(`disk headroom below ${policy.minFreeBytes} bytes at ${p}; command not started`);
      e.infra = true; throw e;
    }
  }
  const scope = fs.mkdtempSync(path.join(root, 'command-'));
  const temp = path.join(scope, 'tmp');
  fs.mkdirSync(temp, { mode: 0o700 });
  const receipt = { version: 1, ownerPid: process.pid, cwd, startedAt: new Date().toISOString(), status: 'running', temp, disposable: policy.disposable };
  writeReceipt(scope, receipt);
  return { scope, temp, receipt, policy };
}

// Project harnesses can start detached groups. Group exit alone is not enough: on Linux also inspect same-UID
// processes for the inherited scope marker, cwd, or open files. Uninspectable processes retain the entire scope.
export function scopeIdle(session) {
  if (!session) return true;
  if (process.platform !== 'linux') return false;
  const within = p => p === session.scope || p.startsWith(`${session.scope}/`);
  for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    const base = `/proc/${pid}`;
    try {
      if (fs.statSync(base).uid !== process.getuid()) continue;
      if (fs.readFileSync(`${base}/environ`).toString().split('\0').includes(`ORCH_ARTIFACTS_DIR=${session.scope}`)) return false;
      for (const f of ['cwd', ...fs.readdirSync(`${base}/fd`).map(n => `fd/${n}`)]) {
        try { if (within(fs.readlinkSync(`${base}/${f}`))) return false; }
        catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) return false; }
      }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) return false; }
  }
  return true;
}

export function endArtifacts(session, { code, quiescent, interrupted = false }) {
  if (!session) return;
  const { scope, temp, receipt, policy } = session;
  if (receipt.finishedAt) return; // repeated finalization must preserve the original audit trail
  // Failed/interrupted/uncertain runs retain everything for diagnosis. Never reap an abandoned run automatically.
  receipt.finishedAt = new Date().toISOString();
  receipt.code = code;
  const eligible = code === 0 && quiescent && !interrupted;
  receipt.status = eligible ? 'cleaning' : 'retained';
  receipt.removed = [];
  if (eligible) {
    const candidates = disposablePaths(temp, policy.disposable);
    receipt.candidates = candidates.map(p => ({ path: path.relative(temp, p), bytes: bytes(p) }));
    // Persist the exact intent before removal; a crash leaves a receipt, never automatic legacy recovery.
    writeReceipt(scope, receipt);
    for (const p of candidates) {
      if (!directory(p) || fs.realpathSync(p) !== p) throw new Error(`artifact changed identity: ${p}`);
      fs.rmSync(p, { recursive: true });
      receipt.removed.push(path.relative(temp, p));
      writeReceipt(scope, receipt);
    }
  }
  if (eligible) receipt.status = 'complete';
  writeReceipt(scope, receipt);
  process.stderr.write(`orch: artifacts ${scope} (${receipt.status}; removed ${receipt.removed.length} declared build directories)\n`);
}
