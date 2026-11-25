const { randomUUID } = require('node:crypto');

// _run gives its children 8 s after SIGTERM: wait longer before SIGKILL so they are not orphaned.
const STOP_GRACE_MS = 10000;
const GRACE_MS = 5000;
const POLL_MS = 200;

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function readProcessStartTime(pid, { platform, readFileSync, execFileSync }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`);
      // comm (field 2) can itself contain spaces and closing parentheses.
      const end = stat.lastIndexOf(')');
      if (end < 0) return null;
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      const startTime = fields[19]; // field 22, counting from state (field 3)
      if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(startTime)) return null;
      // Ticks count from boot: qualify them with the boot id so a record from before a reboot never matches.
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id').trim();
      return /^[0-9a-f-]{36}$/.test(bootId) ? `${bootId}:${startTime}` : null;
    }
    if (platform === 'darwin') {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)]).trim() || null;
    }
  } catch { /* process gone or unreadable */ }
  return null;
}

function readPidRecord(file, readFileSync, owner = null) {
  try {
    // Trust a record only when it is a regular file owned by the user running Rev4a: a data
    // directory writable by someone else must not let them choose which PID root signals.
    if (owner) {
      const stat = owner.lstatSync(file);
      if (!stat.isFile() || stat.uid !== owner.uid) return null;
    }
    const record = JSON.parse(readFileSync(file));
    if (Number.isSafeInteger(record?.pid) && record.pid > 1 && validPort(record.port) &&
        typeof record.startTime === 'string' && record.startTime &&
        typeof record.root === 'string' && record.root) return record;
  } catch { /* missing, unreadable or invalid record */ }
  return null;
}

function writePidRecord(file, record, { writeFileSync, chmodSync, renameSync, unlinkSync }) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      try { unlinkSync(temporary); } catch { /* temporary file may not exist */ }
    }
    throw error;
  }
}

function removePidRecord(file, record, { readFileSync, unlinkSync }) {
  const current = readPidRecord(file, readFileSync);
  if (current?.pid === record.pid && current.startTime === record.startTime &&
      current.port === record.port && current.root === record.root) {
    try { unlinkSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function isRecordedProcess(record, readers) {
  return Boolean(record?.startTime && readProcessStartTime(record.pid, readers) === record.startTime);
}

function describePortListeners(port, { platform, execFileSync }) {
  if (!validPort(port)) return '';
  try {
    let output = '';
    if (platform === 'linux') output = execFileSync('ss', ['-Hltnp', 'sport', '=', `:${port}`]);
    if (platform === 'darwin') output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return output.trim().replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '?');
  } catch {
    return '';
  }
}

async function stopRev4aPids(records, readers, { selfPid, kill, now, sleep, onSignal, onError }) {
  const pending = new Map();
  const signal = (record, name) => {
    const { pid } = record;
    // Read the OS start time again immediately before each signal.
    if (pid === selfPid || !isRecordedProcess(record, readers)) return false;
    try {
      kill(pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') onError?.(pid, name, error);
      return false;
    }
    onSignal?.(pid, name);
    return true;
  };

  for (const record of records) {
    if (!pending.has(record.pid) && signal(record, 'SIGTERM')) pending.set(record.pid, record);
  }
  if (!pending.size) return false;

  const deadline = now() + STOP_GRACE_MS;
  while (pending.size) {
    for (const pid of pending.keys()) {
      try { kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') pending.delete(pid);
      }
    }
    const remaining = deadline - now();
    if (!pending.size || remaining <= 0) break;
    await sleep(Math.min(remaining, POLL_MS));
  }
  for (const record of pending.values()) signal(record, 'SIGKILL');
  return true;
}

async function waitForPort(probe, { now, sleep }) {
  const deadline = now() + GRACE_MS;
  while (!await probe()) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(remaining, POLL_MS));
  }
  return true;
}

module.exports = {
  validPort, readProcessStartTime, readPidRecord, writePidRecord, removePidRecord,
  isRecordedProcess, describePortListeners, stopRev4aPids, waitForPort,
};
