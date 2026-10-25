#!/usr/bin/env node
/**
 * scripts/backup.sh with the system tar (GNU or bsdtar): the top-level backups/ folder is left out of
 * the archive, nested folders named backups (data/backups, shared/<x>/backups) and names with spaces are
 * kept. Temp dirs only; REV4A_DATA_DIR points at one, never at the real data directory.
 *
 *   node scripts/test-backup-sh.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-backup-sh-'));
const data = path.join(tmp, 'data root');
const put = (rel, body = 'x') => {
  const p = path.join(data, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
put('.env', 'A=1\n');
put('data/events.db');
put('data/backups/y');
put('shared/sk/backups/f');
put('shared/with space/file one');
put('backups/agent-a-cold-2026-10-24_000000001.tar.gz');
put('.hidden-top/z');

const out = path.join(tmp, 'out');
const r = spawnSync('bash', [path.join(root, 'scripts', 'backup.sh'), out], {
  env: { ...process.env, REV4A_DATA_DIR: data, HOME: tmp }, encoding: 'utf8',
});
assert.equal(r.status, 0, r.stdout + r.stderr);
const archive = fs.readdirSync(out).find((n) => n.endsWith('.tar.gz'));
assert.ok(archive, 'an archive was written');
const list = spawnSync('tar', ['-tzf', path.join(out, archive)], { encoding: 'utf8' }).stdout
  .split('\n').map((l) => l.replace(/^\.\//, '')).filter(Boolean);
const has = (n) => list.includes(n);
assert.ok(has('.env'), 'top-level files are kept');
assert.ok(has('data/events.db'));
assert.ok(has('data/backups/y'), 'data/backups/ is kept');
assert.ok(has('shared/sk/backups/f'), 'a nested backups folder is kept');
assert.ok(has('shared/with space/file one'), 'names with spaces are kept');
assert.ok(has('.hidden-top/z'), 'hidden top-level folders are kept');
assert.ok(!list.some((n) => n === 'backups' || n === 'backups/' || n.startsWith('backups/')), 'the top-level backups/ is left out');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok   backup.sh keeps nested backups/ folders and leaves out only the top-level one');
console.log('\n1 passed');
