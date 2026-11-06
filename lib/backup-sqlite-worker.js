'use strict';
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

// Literal code: bundlers must not rewrite the subprocess's own require calls.
// WAL format/recovery semantics: https://www.sqlite.org/fileformat2.html#walformat
const SQLITE_SCRIPT = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
const Database = require(input.sqliteModule);
const bad = () => { throw new Error('Invalid SQLite or WAL'); };
const checksum = (buffer, seed, little) => {
  if (buffer.length % 8) bad();
  let [a, b] = seed;
  for (let i = 0; i < buffer.length; i += 8) {
    a = (a + (little ? buffer.readUInt32LE(i) : buffer.readUInt32BE(i)) + b) >>> 0;
    b = (b + (little ? buffer.readUInt32LE(i + 4) : buffer.readUInt32BE(i + 4)) + a) >>> 0;
  }
  return [a, b];
};
function validateWal(file) {
  const db = fs.openSync(file, 'r');
  let pageSize; let dbPages;
  try {
    const header = Buffer.alloc(100);
    if (fs.readSync(db, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0') bad();
    pageSize = header.readUInt16BE(16); if (pageSize === 1) pageSize = 65536;
    const size = fs.fstatSync(db).size;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || size % pageSize) bad();
    dbPages = size / pageSize;
  } finally { fs.closeSync(db); }
  if (!fs.existsSync(file + '-wal')) return;
  const wal = fs.openSync(file + '-wal', 'r');
  try {
    const size = fs.fstatSync(wal).size;
    if (size === 0) return; // A successful TRUNCATE checkpoint leaves an empty WAL.
    const header = Buffer.alloc(32);
    if (size < 32 || fs.readSync(wal, header, 0, 32, 0) !== 32) bad();
    const magic = header.readUInt32BE(0); const little = magic === 0x377f0682;
    if (!little && magic !== 0x377f0683 || header.readUInt32BE(4) !== 3007000 || header.readUInt32BE(8) !== pageSize) bad();
    let sum = checksum(header.subarray(0, 24), [0, 0], little);
    if (sum[0] !== header.readUInt32BE(24) || sum[1] !== header.readUInt32BE(28)) bad();
    const salt1 = header.readUInt32BE(16); const salt2 = header.readUInt32BE(20);
    const frameSize = pageSize + 24;
    if ((size - 32) % frameSize) bad(); // A truncated tail cannot certify complete committed data.
    const frame = Buffer.alloc(frameSize);
    let stale = false; let previousSalt = ''; let staleSum;
    let availablePages = dbPages;
    for (let at = 32; at < size; at += frameSize) {
      if (fs.readSync(wal, frame, 0, frameSize, at) !== frameSize) bad();
      const page = frame.readUInt32BE(0); const commitSize = frame.readUInt32BE(4);
      const first = frame.readUInt32BE(8); const second = frame.readUInt32BE(12);
      if (!page || page > 0xfffffffe || commitSize > 0xfffffffe) bad();
      const stored = [frame.readUInt32BE(16), frame.readUInt32BE(20)];
      if (first === salt1 && second === salt2) {
        if (stale) bad();
        sum = checksum(frame.subarray(0, 8), sum, little);
        sum = checksum(frame.subarray(24), sum, little);
        if (sum[0] !== stored[0] || sum[1] !== stored[1]) bad();
        availablePages = Math.max(availablePages, page);
        if (commitSize > availablePages) bad();
      } else {
        // Checkpoint RESTART may reuse a WAL without truncating old physical
        // frames. Those older-salt frames are ignored by SQLite. Require an
        // different generation and consistent checksum chains within each
        // retained group; the first stale frame has no surviving previous seed.
        if (first === salt1) bad(); // RESTART increments salt-1; salt-2 alone changing is not an old generation.
        const key = first + ':' + second;
        if (key === previousSalt) {
          let next = checksum(frame.subarray(0, 8), staleSum, little);
          next = checksum(frame.subarray(24), next, little);
          if (next[0] !== stored[0] || next[1] !== stored[1]) bad();
        }
        stale = true; previousSalt = key; staleSum = stored;
      }
    }
    // Complete, checksummed uncommitted frames are legitimate. SQLite reads
    // through its last committed frame; they do not authorize a newer schema.
  } finally { fs.closeSync(wal); }
}
try {
  const out = { stateSchemaVersion: null, agentSchemaVersions: Object.create(null), cronJobs: [], cronEvidenceComplete: false };
  for (const item of input.files) {
    validateWal(item.file);
    const db = new Database(item.file, { readonly: true, fileMustExist: true, timeout: 1000 });
    try {
      db.pragma('query_only=ON'); db.pragma('trusted_schema=OFF');
      const checks = db.pragma('integrity_check(10)');
      if (checks.length !== 1 || checks[0].integrity_check !== 'ok') bad();
      const schema = db.pragma('user_version', { simple: true });
      if (!Number.isSafeInteger(schema) || schema < 0) bad();
      if (item.member === '.openclaw/state/openclaw.sqlite') {
        out.stateSchemaVersion = schema;
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cron_jobs'").get()) {
          const sizes = db.prepare('SELECT length(job_json) AS bytes FROM cron_jobs LIMIT 10001').all();
          if (sizes.length > 10000 || sizes.some(row => !Number.isSafeInteger(row.bytes) || row.bytes < 2 || row.bytes > 1048576) || sizes.reduce((sum, row) => sum + row.bytes, 0) > 8388608) bad();
          let complete = true; const ids = new Set();
          for (const row of db.prepare('SELECT job_json FROM cron_jobs LIMIT 10001').all()) {
            let job;
            try { job = JSON.parse(row.job_json); } catch { complete = false; break; }
            if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id || (job.name != null && typeof job.name !== 'string') ||
              (job.declarationKey != null && typeof job.declarationKey !== 'string') || (job.agentId != null && typeof job.agentId !== 'string') ||
              job.id.length > 1024 || (job.name?.length ?? 0) > 4096 || ids.has(job.id)) { complete = false; break; }
            ids.add(job.id);
            out.cronJobs.push({ id: job.id, name: job.name ?? null, declarationKey: job.declarationKey ?? null, agentId: job.agentId ?? null });
          }
          out.cronEvidenceComplete = complete;
          if (!complete) out.cronJobs = [];
        }
      } else {
        const agent = /^\.openclaw\/agents\/([a-zA-Z0-9_-]+)\/agent\/openclaw-agent\.sqlite$/.exec(item.member)?.[1];
        if (agent) out.agentSchemaVersions[agent] = schema;
      }
    } finally { db.close(); }
  }
  process.stdout.write(JSON.stringify(out));
} catch {
  process.stderr.write('Backup SQLite/WAL integrity could not be verified');
  process.exitCode = 1;
}
`;

/** Native integrity_check runs out of process, so the deadline can kill it even inside SQLite. */
function inspectBackupDatabases(files, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Rev4a starts its services with the install root as cwd. Resolve through
    // Node itself: a bundled require.resolve may return a numeric module ID,
    // which a separate Node process cannot use to load the native dependency.
    const installedRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const sqliteModule = installedRequire.resolve('better-sqlite3');
    execFile(process.execPath, ['-e', SQLITE_SCRIPT, JSON.stringify({ files, sqliteModule })],
      { timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error(error.killed ? 'Backup database integrity inspection timed out' : 'Backup SQLite/WAL integrity could not be verified')); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Backup database inspector returned no complete result')); }
      });
  });
}
module.exports = { inspectBackupDatabases };
