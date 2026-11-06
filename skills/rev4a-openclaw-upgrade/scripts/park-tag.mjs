#!/usr/bin/env node
// park-tag.mjs park|restore|status|run --version <v>[,<v>…] [-- <command> …]
//
// Hides local agent-image tags from Rev4a for a while, so Rev4a creates a test agent on an older
// version: Rev4a creates on the newest LOCAL version, found by the tag `openclaw-agent-base:<v>`
// (lib/agent-images.ts localSupportedVersions). Parking moves that tag to
// `rev4a-parked/openclaw-agent-base:<v>` (same image, nothing deleted); restoring moves it back
// and checks it points at the same image id. Needed only when "create the test agents before TO
// is listed" cannot be used, and to create on the OLDEST supported version (park every newer one).
//
//   park     --version 2026.10.10[,2026.9.9]   park the tags; the state is kept in <base>/parked.json
//   restore  --version <v>[,…] | --all          move them back (--all: every version in the state
//                                               file and every `rev4a-parked/…` tag Docker holds)
//   status                                      list what is parked: the state file and Docker's
//                                               `rev4a-parked/openclaw-agent-base` tags, so a lost
//                                               state file (another REV4A_UPGRADE_WORK, a tmpfs
//                                               wiped by a reboot) still shows every parked tag
//   run      --version <v>[,…] -- <command …>   park, run the command, and restore in every case:
//                                               on success, on failure and on Ctrl-C
//
// A tag left parked makes every later create silently use an older version: `run` is the safe
// form; after `park`, `restore` must follow, and `status` shows what is still parked. Never
// touches containers, volumes or the registry. Exit: 0 done; 1 usage/env error or a step failed
// (the message says the exact docker commands to finish by hand); `run` returns the command's
// exit status when parking and restoring both worked.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, baseDir, main, run, versionParts } from './lib.mjs';

const USAGE = `usage: park-tag.mjs park|restore|status|run --version <v>[,<v>…] [--all] [-- <command> …]

Exit: 0 done; 1 usage/env error or a failed step (with the manual commands); run: the command's exit status.`;
const SPEC = { version: 'string', all: 'boolean' };
const LOCAL = 'openclaw-agent-base';
const PARKED = `rev4a-parked/${LOCAL}`;
const STATE = baseDir('parked.json');

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n'); };
/** The image id a reference points at, or null. */
function imageId(ref) {
  const r = run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 30_000 });
  if (r.missing) throw new UsageError('docker is not available on this host');
  return r.rc === 0 ? r.stdout.trim() : null;
}
/** The versions Docker holds as `rev4a-parked/openclaw-agent-base:<v>`, whatever the state file says. */
function parkedInDocker() {
  const r = run('docker', ['images', '--format', '{{.Tag}}', PARKED], { timeoutMs: 30_000 });
  if (r.missing) throw new UsageError('docker is not available on this host');
  if (r.rc !== 0) throw new Error(`docker images ${PARKED} failed: ${r.out.trim().slice(-300)}`);
  return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== '<none>'))].sort();
}
function docker(args) {
  const r = run('docker', args, { timeoutMs: 60_000 });
  if (r.rc !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.out.trim().slice(-300)}`);
}

function park(v) {
  const state = readState();
  const id = imageId(`${LOCAL}:${v}`);
  if (!id) {
    if (state[v]) { console.log(`${v}: already parked (${state[v].id.slice(7, 19)})`); return; }
    throw new UsageError(`${LOCAL}:${v} does not exist locally: nothing to park`);
  }
  docker(['tag', `${LOCAL}:${v}`, `${PARKED}:${v}`]);
  // Only after the parked tag provably holds the image: `rmi` of the last tag would delete it.
  if (imageId(`${PARKED}:${v}`) !== id) throw new Error(`${PARKED}:${v} does not point at ${id}; not removing ${LOCAL}:${v}`);
  state[v] = { id, parkedAt: new Date().toISOString() };
  writeState(state);
  docker(['rmi', `${LOCAL}:${v}`]);
  console.log(`parked ${LOCAL}:${v} (${id.slice(7, 19)}) as ${PARKED}:${v}`);
}

function restore(v) {
  const state = readState();
  const parkedId = imageId(`${PARKED}:${v}`);
  const localId = imageId(`${LOCAL}:${v}`);
  if (!parkedId) {
    if (localId) { delete state[v]; writeState(state); console.log(`${v}: not parked (${LOCAL}:${v} is in place)`); return; }
    throw new Error(`neither ${PARKED}:${v} nor ${LOCAL}:${v} exists: the image is gone; download it again in Rev4a`);
  }
  if (state[v] && state[v].id !== parkedId) throw new Error(`${PARKED}:${v} now points at ${parkedId}, not the parked ${state[v].id}`);
  if (localId && localId !== parkedId) {
    // A newer build took the tag meanwhile (a download, a local build): keep it, and keep the
    // parked image under its own name so nothing is lost.
    throw new Error(`${LOCAL}:${v} exists again and is a different image (${localId.slice(7, 19)}); the parked one stays as ${PARKED}:${v}. Decide which to keep.`);
  }
  if (!localId) docker(['tag', `${PARKED}:${v}`, `${LOCAL}:${v}`]);
  if (imageId(`${LOCAL}:${v}`) !== parkedId) throw new Error(`restoring ${LOCAL}:${v} failed`);
  docker(['rmi', `${PARKED}:${v}`]);
  delete state[v];
  writeState(state);
  console.log(`restored ${LOCAL}:${v} (${parkedId.slice(7, 19)})`);
}

const manual = (v) => `by hand: docker tag ${PARKED}:${v} ${LOCAL}:${v} && docker rmi ${PARKED}:${v}`;

// `run` takes everything after `--` as the command, untouched.
const dd = process.argv.indexOf('--');
const command = dd > 0 ? process.argv.slice(dd + 1) : [];
if (dd > 0) process.argv.splice(dd);

await main(USAGE, SPEC, async (args) => {
  const [action] = args._;
  if (!['park', 'restore', 'status', 'run'].includes(action)) throw new UsageError(`an action is required\n\n${USAGE}`);
  if (action === 'status') {
    const s = readState(); const inDocker = parkedInDocker();
    const lines = Object.entries(s).map(([v, x]) => `${v}: parked ${x.parkedAt} (${x.id.slice(7, 19)})${inDocker.includes(v) ? '' : ` — no ${PARKED}:${v} in Docker: run restore --version ${v} to see where it went`}`);
    // A parked tag the state file does not know: the state was lost (another REV4A_UPGRADE_WORK,
    // a tmpfs emptied by a reboot) while the tag stayed hidden from Rev4a.
    for (const v of inDocker.filter((x) => !s[x])) lines.push(`${v}: parked (${PARKED}:${v} in Docker, not in ${STATE}): restore with restore --version ${v} or restore --all`);
    console.log(lines.length ? lines.join('\n') : 'nothing parked');
    return 0;
  }
  const versions = args.all && action === 'restore' ? [...new Set([...Object.keys(readState()), ...parkedInDocker()])].sort() : String(args.version ?? '').split(',').filter(Boolean);
  if (!versions.length && args.all && action === 'restore') { console.log('nothing parked'); return 0; }
  if (!versions.length) throw new UsageError(`--version is required${action === 'restore' ? ' (or --all)' : ''}`);
  for (const v of versions) if (!versionParts(v) || !/^[\d.-]+$/.test(v)) throw new UsageError(`"${v}" is not a version`);

  const restoreAll = () => {
    let failed = 0;
    for (const v of versions) {
      try { restore(v); } catch (e) { failed++; console.error(`RESTORE FAILED for ${v}: ${e.message}\n  ${manual(v)}`); }
    }
    return failed;
  };
  if (action === 'restore') return restoreAll() ? 1 : 0;
  if (action === 'park') {
    for (const v of versions) {
      try { park(v); } catch (e) { console.error(`PARK FAILED for ${v}: ${e.message}`); restoreAll(); return 1; }
    }
    console.log(`Restore with: node ${path.relative(process.cwd(), process.argv[1])} restore --version ${versions.join(',')}`);
    return 0;
  }
  // run
  if (!command.length) throw new UsageError('run needs a command after --');
  // Ctrl-C reaches the child from the terminal; when it exits, the restore below runs. The
  // handlers cover a signal that arrives while this script itself is parking or restoring.
  const onSignal = (sig) => { console.error(`\n${sig}: restoring parked tags`); const f = restoreAll(); process.exit(f ? 1 : 130); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let status = 1;
  try {
    for (const v of versions) park(v);
    const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    if (r.error) console.error(`could not run ${command[0]}: ${r.error.message}`);
    status = r.status ?? 1;
  } catch (e) {
    console.error(`PARK FAILED: ${e.message}`);
  }
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  return restoreAll() ? 1 : status;
});
