// Project config and run state. The skill folder is Rev4a's and is replaced on update; everything the project
// owns lives in <repo>/.orchestrate/: config.json (the user's, may be committed), NOTES.md (the user's, short)
// and runs/ (written only by these scripts, git-excluded).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_TEST_PATHS } from './harness.mjs';
import { git, OrchError, readJson, setArtifactPolicy, setEnvPolicy, setNetworkTimeout, writeJson } from './util.mjs';
import { ARTIFACT_DEFAULTS, validatePolicy } from './artifacts.mjs';

export const DEFAULTS = {
  version: 1,
  confirmed: false,
  tracker: {
    kind: 'backlog-md',
    dir: 'backlog',
    status: { todo: 'To Do', inProgress: 'In Progress', inCheck: 'In Check', done: 'Done', blocked: 'Blocked' },
  },
  baseBranch: 'main',
  worktreeRoot: '../.worktrees',
  branchPrefix: 'orch/',
  links: ['node_modules'],
  checks: [],
  // { name, command, paths (globs it covers), when: 'gate' | 'merge', timeoutSec, env, fast?: { critical: [spec files] } }
  // With `fast`, the gate runs the card's specs + the critical ones; the whole suite only for a closure card or risky paths.
  harnesses: [],
  // Paths whose change makes the gate run every harness in full (database, migrations, shared code).
  risk: { paths: [] },
  // rule: 'warn' | 'fail' | 'off' — a change to source code without a change to a test file
  tests: { rule: 'warn', paths: DEFAULT_TEST_PATHS },
  // approval: 'owner' (an ok per task) | 'standing' (the owner's recorded consent for this project).
  // Never on a protected branch, never without a gate PASS and a checker PASS.
  // local: merge into the base branch here; pr: push the branch, open a PR, merge it on GitHub (lib/forge.mjs).
  delivery: { mode: 'local', remote: 'origin' },
  // inertPaths: globs whose changes cannot affect a build or a test. When the base moved only in them (plus an in-repo
  // tracker and .orchestrate/), a merge does not repeat the gate's harnesses; project checks always run.
  merge: { approval: 'owner', standing: null, protectedBranches: ['main', 'master', 'production'], inertPaths: [] },
  roles: { coordinator: null, worker: null, checker: null },
  env: { strip: [], keep: [] },
  artifacts: ARTIFACT_DEFAULTS,
  // atRoundLimit: who decides a run that used all its correction rounds: 'owner' (the run waits for them) or
  // 'coordinator' (the owner's standing rule: it asks an advisor sub-agent, then splits or parks the card and goes on).
  limits: { correctionRounds: 2, atRoundLimit: 'owner', checkers: 1, checkTimeoutSec: 900, maxOwnedShare: 0.5, workerTimeoutSec: 3600, checkerTimeoutSec: 1800, networkTimeoutSec: 120 },
};

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

// The primary checkout, also when called from inside one of its worktrees.
export function primaryRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, { allowFail: true });
  if (r.code !== 0) throw new OrchError('not inside a git repository: run orch from the project folder');
  return path.dirname(r.out);
}

export const orchDir = root => path.join(root, '.orchestrate');
export const configFile = root => path.join(orchDir(root), 'config.json');
export const runDir = (root, id) => path.join(orchDir(root), 'runs', id.toUpperCase());

export function loadConfig(root, { requireConfirmed = true } = {}) {
  const file = configFile(root);
  if (!fs.existsSync(file)) throw new OrchError(`no ${path.relative(root, file)}: run "orch init" first`);
  const cfg = merge(DEFAULTS, readJson(file, {}));
  if (cfg.tracker.kind !== 'backlog-md') delete cfg.tracker.dir; // only an in-repo tracker has a folder
  setEnvPolicy(cfg.env);
  setNetworkTimeout(cfg.limits.networkTimeoutSec);
  validatePolicy(cfg.artifacts);
  // Outside every checkout: retained .ts snapshots must not become input to the project's compiler or test scan.
  const artifactId = `${path.basename(root)}-${createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 12)}`;
  setArtifactPolicy({ ...cfg.artifacts, root: path.join(path.dirname(root), '.orchestrate-artifacts', artifactId) });
  if (requireConfirmed && !cfg.confirmed) {
    throw new OrchError('the config is not confirmed yet: show it to the owner ("orch config"), then "orch config --confirm"', 3);
  }
  return cfg;
}

export const saveConfig = (root, cfg) => writeJson(configFile(root), cfg);

// Dotted path set, for "orch config --set roles.worker=provider/model". Values that parse as JSON are JSON.
export function setPath(cfg, assignment) {
  const i = assignment.indexOf('=');
  if (i < 1) throw new OrchError(`--set needs key=value, got "${assignment}"`);
  const keys = assignment.slice(0, i).split('.');
  let raw = assignment.slice(i + 1); let val;
  try { val = JSON.parse(raw); } catch { val = raw; }
  let o = cfg;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  o[keys.at(-1)] = val;
  cfg.confirmed = false; // any change needs the owner's ok again
}

export function loadState(root, id) {
  const file = path.join(runDir(root, id), 'state.json');
  const s = readJson(file, null);
  if (!s) throw new OrchError(`no run for ${id}: "orch start ${id}" first`);
  return s;
}

export function saveState(root, state) { writeJson(path.join(runDir(root, state.id), 'state.json'), state); }

export function event(state, kind, data = {}) {
  state.events.push({ t: new Date().toISOString(), kind, ...data });
}
