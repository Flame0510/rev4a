#!/usr/bin/env node
// neutralize-backup.mjs --in <agent backup .tar.gz> --out <new .tar.gz> [--force]
//
// For the rehearsal on real data: makes a COPY of a real agent backup that a throwaway test agent
// can restore without reaching anyone. The input is only read, never modified. The archive layout
// is Rev4a's (lib/cold-backup.ts: `tar -czf … -C <volume mounted at /root> .`, so entries are
// `./.openclaw/openclaw.json`, `./.agent-token`, …; restore wipes the volume and extracts it,
// lib/agent-restore.ts). Every other entry is copied byte for byte, headers included (owner,
// mode, mtime), so the restore sees the same tree.
//
// What it removes or changes, and prints:
//   openclaw.json   `channels` (Telegram and every other channel: no bot polls, nobody is
//                   messaged) and the `bindings` that route them; `cron.enabled: false` (no job
//                   runs, none sends); `gateway.auth.token|password` (the throwaway's own token
//                   from its environment takes over); the Rev4a provider's apiKey and its
//                   `x-rev4a-agent` header (calls are not metered as the real agent; an Update or
//                   a per-agent provider sync writes the throwaway's own); every other string
//                   under a secret-looking key (token, apiKey, password, secret…), set to
//                   "rev4a-neutralized"; `skills.entries.*.env` and `.apiKey`;
//   state DB        `.openclaw/state/openclaw.sqlite`: every `secret_store_entries` row and the
//                   `authProfiles.store` row of `config_machine_state` (Codex/ChatGPT and other
//                   sign-ins) are deleted, the WAL is folded in and the file VACUUMed, so deleted
//                   values do not survive in free pages; the `-wal`/`-shm` entries are dropped;
//   files dropped   `.agent-token`, `.openclaw/credentials/**`, `agents/*/agent/auth-profiles.json`,
//                   `agents/*/agent/models.json` (provider settings with their keys), `.openclaw/.env`,
//                   `.codex/**` (Codex CLI sign-in), and the CLI credential files Rev4a's detect
//                   probe knows (gh, vercel, supabase, trello, notion).
// Transcripts, memory, workspace files and databases other than the state DB are kept: they are
// the realistic data the rehearsal needs. They may still hold personal data; the copy is for the
// owner's own host, with the owner's ok, and is deleted at the end of the evaluation.
//
// Needs Node with node:sqlite (22.13 or later without a flag). Refuses to write inside a git tree,
// over the input, or over an existing file without --force. Writes an exclusively created unique temporary file and renames it
// only when complete. Exit: 0 written; 1 usage/env error; 2 the archive has a shape this script
// does not handle safely (nothing is written).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { UsageError, Untrustworthy, assertOutsideGit, main } from './lib.mjs';

const USAGE = `usage: neutralize-backup.mjs --in <agent backup .tar.gz> --out <new .tar.gz> [--force]

Exit: 0 written; 1 usage/env error; 2 archive not handled safely (nothing written).`;
const SPEC = { in: 'string', out: 'string', force: 'boolean' };

const CONFIG = '.openclaw/openclaw.json';
const STATE_DB = '.openclaw/state/openclaw.sqlite';
const DROP = [
  /^\.agent-token$/, /^\.openclaw\/credentials(\/|$)/, /^\.openclaw\/agents\/[^/]+\/agent\/auth-profiles\.json$/, /^\.codex(\/|$)/,
  // Per-agent copies of the provider settings (apiKey and the Rev4a proxy key included), and the
  // agent's own environment file: OpenClaw writes models.json again from openclaw.json.
  /^\.openclaw\/agents\/[^/]+\/agent\/models\.json$/, /^\.openclaw\/\.env$/,
  /^\.config\/gh\/hosts\.yml$/, /^\.local\/share\/com\.vercel\.cli\/auth\.json$/, /^\.supabase\/access-token$/,
  /^\.config\/trello\/config\.json$/, /^\.config\/notion\/config\.json$/,
];
const SECRET_KEY = /^(token|botToken|controlToken|accessToken|refreshToken|idToken|apiKey|api_key|password|secret|clientSecret|webhookToken|privateKey|[A-Z][A-Z0-9_]*(_KEY|_TOKEN|_SECRET|PASSWORD|_PAT))$/;

const norm = (n) => n.replace(/^\.\//, '').replace(/\/$/, '');

// ── A minimal tar reader/writer (ustar and GNU; long names through `L`/`K` entries) ──

/** Pull exactly n bytes at a time from an async iterator of Buffers. */
class Reader {
  constructor(iter) { this.it = iter[Symbol.asyncIterator](); this.buf = Buffer.alloc(0); this.done = false; }
  async read(n) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) this.done = true; else this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    if (out.length !== n) throw new Untrustworthy(`archive truncated: expected ${n} bytes, got ${out.length}`);
    return out;
  }
}
const cstr = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString('utf8'); };
function sizeOf(h) {
  const f = h.subarray(124, 136);
  if (f[0] & 0x80) { let v = 0; for (let i = 1; i < 12; i++) v = v * 256 + f[i]; return v; }
  return parseInt(cstr(f).trim() || '0', 8);
}
const isZero = (b) => b.every((x) => x === 0);
const padded = (n) => Math.ceil(n / 512) * 512;
/** A copy of a header with a new size and a recomputed checksum. */
function withSize(h, size) {
  const n = Buffer.from(h);
  n.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  n.fill(0x20, 148, 156);
  let sum = 0; for (const x of n) sum += x;
  n.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return n;
}

/**
 * Walk the archive: `visit(entry)` gets { name, type, size, meta: [Buffer…], header } and returns
 * 'skip' | 'body' (a Buffer of the content is passed to `onBody`) | 'stream' (content copied
 * to `onChunk` in pieces). `meta` holds the GNU L/K blocks that belong to the entry.
 */
async function walkTar(file, visit, { onBody, onChunk, onEnd } = {}) {
  const r = new Reader(fs.createReadStream(file).pipe(zlib.createGunzip()));
  let meta = []; let longName = null;
  for (;;) {
    const h = await r.read(512);
    if (isZero(h)) {
      if (!isZero(await r.read(512))) throw new Untrustworthy('archive lacks its second end marker');
      break;
    }
    if (cstr(h.subarray(257, 263)) && !/^ustar/.test(cstr(h.subarray(257, 263)))) throw new Untrustworthy('not a ustar/GNU tar archive');
    const type = String.fromCharCode(h[156] || 48);
    const size = sizeOf(h);
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (type === 'x' || type === 'g') throw new Untrustworthy('the archive has a pax header: not handled safely');
      const body = await r.read(padded(size));
      meta.push(Buffer.concat([h, body]));
      if (type === 'L') longName = cstr(body.subarray(0, size));
      continue;
    }
    const prefix = cstr(h.subarray(345, 500));
    const name = norm(longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100))));
    const entry = { name, type, size, meta, header: h };
    meta = []; longName = null;
    const what = await visit(entry);
    if (what === 'body') {
      const body = await r.read(padded(size));
      await onBody?.(entry, body.subarray(0, size));
    } else if (what === 'stream') {
      let left = padded(size);
      while (left > 0) { const c = await r.read(Math.min(left, 1 << 20)); if (!c.length) throw new Untrustworthy(`archive truncated inside ${name}`); left -= c.length; await onChunk?.(c); }
    } else {
      let left = padded(size);
      while (left > 0) { const c = await r.read(Math.min(left, 1 << 20)); if (!c.length) throw new Untrustworthy(`archive truncated inside ${name}`); left -= c.length; }
    }
  }
  await onEnd?.();
}

// ── The changes ─────────────────────────────────────────────────────────────

function neutralizeConfig(cfg, log) {
  if (cfg.channels && Object.keys(cfg.channels).length) { log(`config: removed channels ${Object.keys(cfg.channels).join(', ')}`); delete cfg.channels; }
  if (Array.isArray(cfg.bindings)) {
    const before = cfg.bindings.length;
    cfg.bindings = cfg.bindings.filter((b) => !b?.match?.channel);
    if (before !== cfg.bindings.length) log(`config: removed ${before - cfg.bindings.length} channel binding(s)`);
  }
  cfg.cron = { ...(cfg.cron ?? {}), enabled: false };
  log('config: cron.enabled = false');
  for (const k of ['token', 'password']) if (cfg.gateway?.auth?.[k] !== undefined) { delete cfg.gateway.auth[k]; log(`config: removed gateway.auth.${k}`); }
  const rev4a = cfg.models?.providers?.rev4a;
  if (rev4a) {
    if (rev4a.apiKey !== undefined) { delete rev4a.apiKey; log('config: removed models.providers.rev4a.apiKey (an Update or a provider sync writes the test agent\'s own)'); }
    if (rev4a.headers && 'x-rev4a-agent' in rev4a.headers) { delete rev4a.headers['x-rev4a-agent']; log('config: removed the x-rev4a-agent header'); }
  }
  for (const [name, e] of Object.entries(cfg.skills?.entries ?? {})) {
    for (const k of ['env', 'apiKey']) if (e && typeof e === 'object' && e[k] !== undefined) { delete e[k]; log(`config: removed skills.entries.${name}.${k}`); }
  }
  // Anything else that looks like a secret: replaced, not removed, so a required field stays valid.
  const walk = (v, p) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && x && SECRET_KEY.test(k) && x !== 'rev4a-neutralized') { v[k] = 'rev4a-neutralized'; log(`config: replaced ${p}${k}`); } else walk(x, `${p}${k}.`);
    }
  };
  walk(cfg, '');
  return cfg;
}

async function neutralizeStateDb(dir, log) {
  let DatabaseSync;
  // Node 22 prints an ExperimentalWarning for node:sqlite: noise in the list of what was removed.
  process.removeAllListeners('warning');
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
    throw new UsageError(`node:sqlite is not available in Node ${process.versions.node}: use Node 22.13 or later`);
  }
  // A -shm from another host is only an index: SQLite rebuilds it from the WAL.
  fs.rmSync(path.join(dir, 'openclaw.sqlite-shm'), { force: true });
  const db = new DatabaseSync(path.join(dir, 'openclaw.sqlite'));
  try {
    const has = (t) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', t);
    if (has('secret_store_entries')) { const n = db.prepare('DELETE FROM secret_store_entries').run().changes; log(`state DB: deleted ${n} secret_store_entries row(s)`); } else log('state DB: no secret_store_entries table');
    if (has('config_machine_state')) { const n = db.prepare("DELETE FROM config_machine_state WHERE state_key = 'authProfiles.store'").run().changes; log(`state DB: deleted ${n} authProfiles.store row(s) (sign-ins)`); } else log('state DB: no config_machine_state table');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
  } finally { db.close(); }
  return fs.readFileSync(path.join(dir, 'openclaw.sqlite'));
}

await main(USAGE, SPEC, async (args) => {
  if (!args.in || !args.out) throw new UsageError(`--in and --out are required\n\n${USAGE}`);
  const input = path.resolve(args.in); const output = path.resolve(args.out);
  if (!fs.existsSync(input)) throw new UsageError(`${input} does not exist`);
  const inputStat = fs.statSync(input);
  const inputReal = fs.realpathSync(input);
  const rejectInputAlias = (candidate) => {
    if (candidate === input) throw new UsageError('Output must differ from input');
    try {
      const stat = fs.statSync(candidate);
      if (fs.realpathSync(candidate) === inputReal || (stat.ino === inputStat.ino && stat.dev === inputStat.dev)) {
        throw new UsageError('Output must not alias the input (including symbolic and hard links)');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  rejectInputAlias(output);
  if (!/\.tar\.gz$/.test(output)) throw new UsageError('--out must end in .tar.gz (Rev4a lists backups by that name)');
  assertOutsideGit(output);
  if (fs.existsSync(output) && !args.force) throw new UsageError(`${output} exists: pass --force to replace it`);

  let partial = null; let partialStat = null;
  const removed = [];
  const log = (s) => { removed.push(s); console.log(s); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-neutralize-'));
  fs.chmodSync(tmp, 0o700);
  try {
    // Pass 1: read the config and the state DB (with its WAL) out of the archive.
    let cfgText = null; let sawDb = false;
    const want = new Set([CONFIG, STATE_DB, `${STATE_DB}-wal`, `${STATE_DB}-shm`]);
    await walkTar(input, (e) => (want.has(e.name) && e.type === '0' ? 'body' : 'skip'), {
      onBody: (e, body) => {
        if (e.name === CONFIG) cfgText = body.toString('utf8');
        else { sawDb ||= e.name === STATE_DB; fs.writeFileSync(path.join(tmp, path.basename(e.name)), body, { mode: 0o600 }); }
      },
    });
    if (cfgText === null) throw new Untrustworthy(`no ${CONFIG} in the archive: not an agent backup (lib/cold-backup.ts requires it)`);
    let cfg;
    try { cfg = JSON.parse(cfgText); } catch (e) { throw new Untrustworthy(`${CONFIG} is not JSON: ${e.message}`); }
    const newCfg = Buffer.from(JSON.stringify(neutralizeConfig(cfg, log), null, 2) + '\n');
    const newDb = sawDb ? await neutralizeStateDb(tmp, log) : (log('state DB: not in the archive'), null);

    // Pass 2: copy everything, replacing the two files and dropping the rest of the list.
    partial = output + '.tmp-' + randomUUID();
    rejectInputAlias(partial);
    const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    partialStat = fs.fstatSync(fd);
    if (partialStat.ino === inputStat.ino && partialStat.dev === inputStat.dev) {
      fs.closeSync(fd);
      partialStat = null;
      throw new UsageError('Temporary output aliases the input');
    }
    const gz = zlib.createGzip();
    const sink = new PassThrough();
    const done = pipeline(sink, gz, fs.createWriteStream(partial, { fd, autoClose: true }));
    const write = (b) => (sink.write(b) ? null : new Promise((res) => sink.once('drain', res)));
    void done.catch(() => {});
    let dropped = 0;
    try { await walkTar(input, async (e) => {
      if (DROP.some((re) => re.test(e.name)) || (newDb && (e.name === `${STATE_DB}-wal` || e.name === `${STATE_DB}-shm`))) {
        if (e.type === '0') { dropped++; log(`dropped ${e.name}`); }
        return 'skip';
      }
      const replace = e.type === '0' && (e.name === CONFIG ? newCfg : e.name === STATE_DB ? newDb : null);
      if (replace) {
        for (const m of e.meta) await write(m);
        await write(withSize(e.header, replace.length));
        await write(Buffer.concat([replace, Buffer.alloc(padded(replace.length) - replace.length)]));
        return 'skip';
      }
      for (const m of e.meta) await write(m);
      await write(e.header);
      return 'stream';
    }, { onChunk: write, onEnd: async () => { await write(Buffer.alloc(1024)); sink.end(); } });
    await done;
    } catch (error) { sink.destroy(error); await done.catch(() => {}); throw error; }
    rejectInputAlias(output);
    if (!args.force && fs.existsSync(output)) throw new UsageError('Output appeared during neutralization; refusing to replace it');
    fs.renameSync(partial, output);
    partial = null;
    console.log(`-> ${output} (${dropped} file(s) dropped, ${removed.length} change(s)); the input is unchanged`);
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (partial && partialStat) {
      const current = fs.lstatSync(partial, { throwIfNoEntry: false });
      if (current?.ino === partialStat.ino && current?.dev === partialStat.dev) fs.unlinkSync(partial);
    }
  }
});
