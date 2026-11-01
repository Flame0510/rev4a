#!/usr/bin/env node
// orch — the mechanics and state of the orchestrate skill. The coordinator runs these commands and reads their
// short output (always ending with "next: …"); it never keeps a ledger of its own. Node built-ins only.
//
//   orch init [--base <branch>] [--models a,b,c] [--force]   write .orchestrate/config.json (to be confirmed)
//   orch config [--set key=value]... [--confirm]             show or change the config
//   orch config --standing-approval <owner> | --owner-approval   merge without / with an ok per task
//   orch next [--all] [--json]                               eligible tasks (and why the others are not)
//   orch start <id> [--force]                                worktree + branch, status In Progress, worker prompt
//   orch record <id> worker|checker [--tag a] [--from f] [--tokens n]   save a sub-agent's report
//   orch gate <id>                                           scope, counts, checks; on PASS the checker prompts
//   orch fix <id>                                            next correction round (at most limits.correctionRounds)
//   orch push <id>                                           delivery pr: commit the gated tree, push, open/update the PR
//   orch resolve <id> --checked <what>                       record that an unchecked merged result was checked
//   orch campaign start|stop|status|job-script               the owner's mandate to work cards to the end, one coordinator
//   orch keeper [--json]                                     wake | wait | escalate | done, for the keeper automation
//   orch finish <id> [--approved-by <name>] [--override <why>]  commit, merge --no-ff, checks on the merge, Done
//   orch park <id> --reason <why>                            status Blocked, worktree kept
//   orch status [<id>] [--json]                              where each run is and what to do next
//   orch prompt <id> worker|checker                          print the path of the current prompt file(s)
//   orch harness <name> [--in <id>]                          run one harness now (base branch, or a task's worktree)
//   orch card new|split|check|normalise …                    create and fix cards in the skill's format (lib/card-cmd.mjs)
//   orch card set-aside <id>                                 set a card's run aside (done by split; reruns a half-done one)
//   orch artifacts [gc [--unowned]]                          command scopes: list, delete what merged/older runs left
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactsDir, configFile, DEFAULTS, event, loadConfig, loadState, orchDir, primaryRoot, runDir, saveConfig, saveState, setPath,
} from './lib/config.mjs';
import { matchesAny } from './lib/glob.mjs';
import {
  cardSpecFiles, detectHarnesses, failedSpecFiles, harnessesCovering, harnessesFor, harnessPlan, OUTPUT_DIRS, riskyFiles,
  runHarness, shq, testRule,
} from './lib/harness.mjs';
import { cardRules } from './lib/card.mjs';
import { CAMPAIGN_DEFAULTS, decide, wakeMessage } from './lib/keeper.mjs';
import { cmdCard } from './lib/card-cmd.mjs';
import { validatePolicy } from './lib/artifacts.mjs';
import { applyGc, planGc, scopeBytes } from './lib/artifact-gc.mjs';
import { ensurePr, fetchBase, gh, mergePr, postStatus, prView, pushExact, remoteSha } from './lib/forge.mjs';
import { evaluate } from './lib/select.mjs';
import { excludeOnce, fill, git, lastLines, minutes, now, OrchError, readJson, redactSecrets, sh, writeAtomic, writeJson } from './lib/util.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOL = new Set(['force', 'confirm', 'json', 'all', 'owner-approval', 'dry-run', 'unowned']);

function parseArgs(argv) {
  const pos = []; const flags = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined && !BOOL.has(k)) {
      v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new OrchError(`--${k} needs a value`);
      i++;
    }
    if (k === 'set') flags.set.push(v); else flags[k] = v ?? true;
  }
  return { pos, flags };
}

const out = (...lines) => console.log(lines.filter(l => l !== null && l !== undefined).join('\n'));

async function trackerFor(root, cfg) {
  const file = path.join(SKILL, 'scripts', 'trackers', `${cfg.tracker.kind}.mjs`);
  if (!fs.existsSync(file)) throw new OrchError(`no tracker adapter "${cfg.tracker.kind}" (have: ${fs.readdirSync(path.dirname(file)).map(f => f.replace(/\.mjs$/, '')).join(', ')})`);
  const mod = await import(file);
  return mod.createTracker(root, cfg.tracker);
}

const tpl = name => fs.readFileSync(path.join(SKILL, 'templates', `${name}.md`), 'utf8');
const trackedFiles = root => git(['ls-files'], root).split('\n').filter(Boolean);
const block = list => (list.length ? list.join('\n') : '(none)');

// Stage everything in the worktree (its own index; never committed here) and name the resulting tree.
function stageAndTree(wt) {
  git(['add', '-A'], wt);
  return git(['write-tree'], wt);
}

function checksFor(cfg, task) { return [...cfg.checks, ...task.checks]; }

// ---------------------------------------------------------------------------------------------------- next action

// When the current phase was opened: a report older than that belongs to an earlier round. Working opens with start or
// fix, checking with the gate (local) or the push (PR).
function phaseOpenedAt(st) {
  const kinds = st.phase === 'working' ? ['start', 'fix'] : ['gate', 'push'];
  return Date.parse([...st.events].reverse().find(e => kinds.includes(e.kind))?.t ?? 0) || 0;
}

// Reports left in the inbox by an earlier round go to reports/, renamed, so nobody records them as the current one.
function setAsideInbox(root, st, only = () => true) {
  const dir = path.join(runDir(root, st.id), 'inbox');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(only) : []) setAsideFile(root, st, path.join(dir, name));
}

// Moves a report to reports/stale-<time>-<name> under a name nothing else has: reports are moved, never overwritten.
function setAsideFile(root, st, file) {
  const base = path.join(runDir(root, st.id), 'reports', `stale-${now().replace(/[^0-9]/g, '')}-${path.basename(file)}`);
  let dest = base;
  for (let i = 2; fs.existsSync(dest); i++) dest = base.replace(/\.md$/, '') + `-${i}.md`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(file, dest);
}

// Whether this round's checker tag may report under the older releases' name checker-<tag>.md: only when its brief was
// written by an older release (it does not name checker-r<round>-<tag>.md). A round briefed by this release never does.
function legacyCheckerName(root, st, tag) {
  const p = (st.checkerPrompts ?? []).find(x => x.tag === tag)?.prompt;
  try { return !fs.readFileSync(p, 'utf8').includes(`checker-r${st.round}-${tag}.md`); } catch { return true; }
}

// The run of a command that works on it: not one a split is setting aside (its worktree may have moved already).
function activeState(root, id) {
  const st = loadState(root, id);
  if (st.setAside) throw new OrchError(`${st.id} is being set aside by a split: orch card set-aside ${st.id} finishes that`);
  return st;
}

// Whether the coordinator decides a run at its round limit itself (the owner's standing rule) instead of the owner.
const selfDecides = cfg => cfg.limits.atRoundLimit === 'coordinator';

function nextAction(st, cfg) {
  const id = st.id; const max = cfg.limits.correctionRounds;
  if (st.setAside) return `orch card set-aside ${id} (a split set this run aside half-way: finish that; the card then waits for its split cards)`;
  const roundsLeft = st.round < max;
  const selfDecide = `round limit reached (${st.round}/${max}): you decide, by the owner's standing rule (limits.atRoundLimit "coordinator"). `
    + `orch prompt ${id} advisor writes the advisor's brief: delegate it to one sub-agent (label "${id} advisor r${st.round}") and wait for its report. `
    + `Then either split the card (orch card split ${id} --from <cards.json>: small cards that do not overlap) or orch park ${id} --reason "<why>". `
    + `Never orch finish it: a card is merged only after a gate PASS and a checker PASS. Tell the owner in one line what you decided and why, then orch next`;
  const decide = selfDecides(cfg) ? selfDecide
    : `round limit reached (${st.round}/${max}): decide with the owner — accept (orch finish ${id} --approved-by <name> --override "<why>", only after a gate PASS), split the task, or orch park ${id} --reason "<why>"`;
  switch (st.phase) {
    case 'working': return `${spawnLine(cfg, 'worker', st, st.prompt, cfg.limits.workerTimeoutSec)} When it has finished: orch record ${id} worker`;
    case 'worked': return `orch gate ${id}`;
    case 'gated': return `orch push ${id}`;
    case 'gate-failed': return roundsLeft ? `orch fix ${id}` : selfDecides(cfg) ? selfDecide : `round limit reached (${st.round}/${max}) and the gate fails, so it cannot be accepted: decide with the owner — split the task, or orch park ${id} --reason "<why>"`;
    case 'rejected': return roundsLeft ? `orch fix ${id}` : decide;
    case 'checking': {
      const done = new Set(currentVerdicts(st).map(v => v.tag));
      const todo = st.checkerPrompts.filter(p => !done.has(p.tag));
      return todo.map(p => `${spawnLine(cfg, `checker ${p.tag}`, st, p.prompt, cfg.limits.checkerTimeoutSec)} Then: orch record ${id} checker --tag ${p.tag}`).join('\nnext: ');
    }
    case 'ready': return standingApproval(cfg)
      ? `orch finish ${id} (standing merge approval of ${cfg.merge.standing.by})`
      : `ask the owner for the merge ok, then: orch finish ${id} --approved-by <name>`;
    case 'merged': if (unresolvedUntested(st)) return `run the checks on ${st.baseBranch} (merged result ${st.merge?.slice(0, 9)} was never checked), then orch resolve ${id} --checked "<what passed>"`;
      return st.finishPending?.length ? `orch finish ${id} (merged; still to do: ${st.finishPending.join(', ')})` : 'nothing: merged';
    case 'parked': return unresolvedUnsafe(st)
      ? `tell the owner: ${st.parkReason}. After their decision: orch resolve ${id} --checked "<what was decided and checked>"`
      : `nothing: parked (${st.parkReason})`;
    default: return `unknown phase ${st.phase}`;
  }
}

// The owner's standing consent, valid only when the base branch is not a protected one.
const standingApproval = cfg => cfg.merge.approval === 'standing' && cfg.merge.standing?.by
  && !cfg.merge.protectedBranches.includes(cfg.baseBranch);

/**
 * How to start a worker or a checker: an OpenClaw sub-agent session (its own lifecycle, completion delivered to the
 * coordinator, visible in Rev4a's Lineage when the agent runs under Rev4a) — never a runtime-native child such as Codex spawn_agent, which can stop when
 * the coordinator's turn changes and whose completion may never arrive (tourguide, night of 2026-10-25).
 */
// The label names the session in OpenClaw and in Rev4a's Lineage ("SB-60.2 worker r1"); the task name is
// the coordinator's handle for the same child, in the form OpenClaw accepts ([a-z][a-z0-9_-]{0,63}).
function spawnLine(cfg, role, st, prompt, timeoutSec) {
  const model = role.startsWith('checker') ? cfg.roles.checker : cfg.roles.worker;
  const cwd = st.worktree;
  const label = `${st.id} ${role} r${st.round}`;
  const taskName = ('t-' + label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, 64);
  return `delegate the ${role} to a separate OpenClaw sub-agent session — this is OpenClaw delegation of a whole card, `
    + `required by this skill and its owner (own lifecycle, completion delivered to you, visible to the owner), not internal `
    + `legwork, so use the OpenClaw tool sessions_spawn and NOT a native spawn_agent: runtime "subagent", `
    + `label "${label}", taskName "${taskName}", model "${model ?? 'see config'}", cwd "${cwd}", runTimeoutSeconds ${timeoutSec ?? 3600}, `
    + `task "Read ${prompt} and do what it says."; then wait with sessions_yield (no polling).`;
}

const currentVerdicts = st => (st.gate ? st.verdicts.filter(v => v.tree === st.gate.tree && v.round === st.round) : []);

function metrics(st) {
  const first = Date.parse(st.events[0]?.t); const last = Date.parse(st.events.at(-1)?.t);
  const tokens = st.events.reduce((n, e) => n + (Number(e.tokens) || 0), 0);
  const gates = st.events.filter(e => e.kind === 'gate');
  return {
    elapsed: minutes(last - first), rounds: st.round, gates: gates.length,
    gateFails: gates.filter(g => !g.pass).length,
    checkerVerdicts: st.verdicts.map(v => `${v.round}${v.tag}:${v.verdict}`).join(' ') || '-',
    tokens: tokens || null,
  };
}

const unresolvedUntested = st => Boolean(st.untestedMerge && !st.untestedResolved);
const unresolvedUnsafe = st => Boolean(st.unsafeMerge && !st.unsafeResolved);
const blocking = st => unresolvedUntested(st) || unresolvedUnsafe(st);

// Runs whose merge needs a person before anything else starts: merged into the wrong branch or head (unsafe), or a
// merged result nobody has checked (the base moved during GitHub's merge).
function untestedRuns(root) {
  const runs = path.join(orchDir(root), 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).filter(d => fs.existsSync(path.join(runs, d, 'state.json'))).map(d => loadState(root, d)).filter(blocking);
}

function statusLine(st, cfg) {
  const g = st.gate ? `gate ${st.gate.pass ? 'PASS' : 'FAIL'} (${st.gate.files} files +${st.gate.added} -${st.gate.removed}, checks ${st.gate.checksPassed}/${st.gate.checksRun})` : 'gate not run';
  const m = metrics(st);
  return [
    `${st.id}  ${st.title}`,
    `  phase ${st.phase} · round ${st.round}/${cfg.limits.correctionRounds} · ${g} · checkers ${m.checkerVerdicts}`,
    `  elapsed ${m.elapsed} · gate runs ${m.gates} (${m.gateFails} failed)${m.tokens ? ` · tokens ${m.tokens}` : ''} · worktree ${st.worktree}`,
    ...(st.pr ? [`  PR #${st.pr.number} ${st.pr.url} · pushed ${st.sha?.slice(0, 9) ?? '-'}`] : []),
    ...(unresolvedUntested(st) ? [`  ATTENTION: the merged result ${st.merge?.slice(0, 9)} on ${st.baseBranch} is not the checked tree: run the checks on ${st.baseBranch}, then orch resolve ${st.id} --checked "<what passed>"`] : []),
    `next: ${nextAction(st, cfg)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------- commands

async function cmdInit(root, { flags }) {
  if (fs.existsSync(configFile(root)) && !flags.force) throw new OrchError(`${configFile(root)} exists (--force to rewrite it)`);
  const cfg = structuredClone(DEFAULTS);
  let statuses = null;
  if (flags.tracker === 'trello') {
    // Nothing in a repository names a board: the owner gives it; the open lists become the proposed statuses.
    if (!flags.board || flags.board === true) throw new OrchError('orch init --tracker trello needs --board <board id> (and --id-prefix <letters>)');
    cfg.tracker = { ...cfg.tracker, kind: 'trello', board: String(flags.board), idPrefix: String(flags['id-prefix'] || 'TR').toUpperCase() };
    delete cfg.tracker.dir;
    if (flags['filter-label']) cfg.tracker.filter = { label: String(flags['filter-label']), mode: flags['filter-mode'] === 'exclude' ? 'exclude' : 'only' };
    statuses = (await trackerFor(root, cfg)).statuses();
  } else {
    const backlog = (await import(path.join(SKILL, 'scripts', 'trackers', 'backlog-md.mjs'))).detect(root);
    if (!backlog) throw new OrchError('no supported tracker found: a Backlog.md backlog/tasks folder, or orch init --tracker trello --board <id>');
    cfg.tracker.kind = backlog.kind; cfg.tracker.dir = backlog.dir;
    statuses = backlog.statuses;
  }
  if (statuses) {
    const pick = (re, fallback) => statuses.find(s => re.test(s)) ?? fallback;
    cfg.tracker.status = {
      todo: pick(/^(to ?do|backlog)$/i, statuses[0]), inProgress: pick(/progress/i, 'In Progress'),
      inCheck: pick(/check|review/i, pick(/progress/i, 'In Progress')), done: pick(/^done$/i, 'Done'),
      blocked: pick(/block|park|hold/i, cfg.tracker.kind === 'trello' ? null : pick(/progress/i, 'In Progress')),
    };
  }
  const trackerNote = cfg.tracker.kind === 'trello'
    ? ['check tracker.status.done: the list a card goes to when it is merged into the base branch (where "Done" means production, that is a review list such as "In Review"); blocked null = no list, a comment only']
    : [];
  cfg.baseBranch = flags.base || git(['branch', '--show-current'], root) || 'main';
  const pkg = readJson(path.join(root, 'package.json'), null);
  const scripts = pkg?.scripts ?? {};
  cfg.checks = scripts.check ? ['npm run check'] : ['typecheck', 'lint', 'test'].filter(s => scripts[s]).map(s => `npm run ${s}`);
  // Untracked env files are missing in a fresh worktree, and checks or e2e servers that read them would fail there.
  const envFiles = ['.env.local', '.env', '.env.test', '.env.test.local', '.env.development.local']
    .filter(f => fs.existsSync(path.join(root, f)) && git(['ls-files', '--error-unmatch', f], root, { allowFail: true }).code !== 0);
  cfg.links = [...(fs.existsSync(path.join(root, 'node_modules')) ? ['node_modules'] : []), ...envFiles];
  const found = detectHarnesses(root, scripts);
  if (envFiles.length) found.notes.push(`linked into each worktree, never copied and never staged: ${envFiles.join(', ')} (a fresh worktree has no untracked env file)`);
  cfg.harnesses = found.harnesses;

  const models = flags.models ? String(flags.models).split(',').map(s => s.trim()).filter(Boolean) : agentModels();
  Object.assign(cfg.roles, proposeRoles(models));
  saveConfig(root, cfg);
  excludeOnce(root, '/.orchestrate/runs/');
  excludeOnce(root, '/.orchestrate/harness.lock/');
  if (cfg.harnesses.length) for (const d of OUTPUT_DIRS) excludeOnce(root, d);
  out(`wrote ${path.relative(root, configFile(root))} (not confirmed yet)`, '', showConfig(cfg, models),
    ...[...trackerNote, ...found.notes].map(n => `note: ${n}`),
    '', `next: show this to the owner; change what they want with orch config --set key=value${cfg.harnesses.length ? `; run each harness once on ${cfg.baseBranch} (${cfg.harnesses.map(h => `orch harness ${h.name}`).join(', ')}): if it fails there, every gate would fail` : ''}; then orch config --confirm`);
}

// Models the agent has, from its OpenClaw config: primary, fallbacks, then the allowed list.
function agentModels() {
  const file = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
  const c = readJson(file, null);
  const d = c?.agents?.defaults ?? {};
  const m = typeof d.model === 'string' ? { primary: d.model } : d.model ?? {};
  return [...new Set([m.primary, ...(m.fallbacks ?? []), ...Object.keys(d.models ?? {})].filter(Boolean))];
}

const CHEAP = /flash|mini|haiku|lite|nano|small|air\b/i;

export function proposeRoles(models) {
  if (!models.length) return { coordinator: null, worker: null, checker: null, note: 'no models found: set roles.* by hand' };
  const coordinator = models[0];
  const cheap = models.find(m => CHEAP.test(m) && m !== coordinator) ?? (CHEAP.test(coordinator) ? coordinator : null);
  const strong = models.find(m => !CHEAP.test(m)) ?? coordinator;
  if (models.length === 1) return { coordinator, worker: coordinator, checker: coordinator, note: 'one model: the checker is the same model in a fresh session' };
  const worker = cheap ?? coordinator;
  const checker = worker === strong ? models.find(m => m !== worker) : strong;
  return { coordinator, worker, checker, note: 'cheaper worker, different and stronger checker' };
}

function showConfig(cfg, models) {
  return [
    models ? `models found: ${models.join(', ') || '(none)'}` : null,
    `roles: coordinator ${cfg.roles.coordinator} · worker ${cfg.roles.worker} · checker ${cfg.roles.checker}${cfg.roles.note ? ` (${cfg.roles.note})` : ''}`,
    `tracker: ${cfg.tracker.kind === 'trello' ? `trello board ${cfg.tracker.board} · ids ${cfg.tracker.idPrefix}-<n>${cfg.tracker.filter ? ` · ${cfg.tracker.filter.mode === 'exclude' ? 'without' : 'only'} label "${cfg.tracker.filter.label}"` : ''}` : `${cfg.tracker.kind} in ${cfg.tracker.dir}/`} · statuses ${Object.entries(cfg.tracker.status).map(([k, v]) => `${k}="${v}"`).join(' ')}`,
    `base branch: ${cfg.baseBranch} · worktrees in ${cfg.worktreeRoot} · branches ${cfg.branchPrefix}<id> · links ${cfg.links.join(', ') || '-'}`,
    `checks: ${cfg.checks.join(' · ') || '(none: set checks)'}`,
    `artifacts: ${cfg.artifacts.enabled ? 'enabled' : 'disabled'} · reserve ${cfg.artifacts.minFreeBytes} bytes · disposable ${cfg.artifacts.disposable.join(', ') || '(none)'}`,
    ...(cfg.harnesses.length ? cfg.harnesses.map(h => `harness ${h.name}: ${h.command} · on ${h.when ?? 'gate'} when a change touches ${(h.paths ?? ['**']).join(', ')} · ${h.timeoutSec ?? 1800} s`) : ['harnesses: none']),
    `tests: rule ${cfg.tests.rule} (a source change needs a changed test file) · test files ${cfg.tests.paths.join(', ')}`,
    `merge: ${cfg.merge.approval === 'standing' && cfg.merge.standing ? `standing approval of ${cfg.merge.standing.by} since ${cfg.merge.standing.at}` : 'the owner\'s ok for each task'} · never on ${cfg.merge.protectedBranches.join(', ')}`,
    `limits: ${cfg.limits.correctionRounds} correction rounds · ${cfg.limits.checkers} checker(s) · ${cfg.limits.checkTimeoutSec} s per check · a task may own at most ${Math.round(cfg.limits.maxOwnedShare * 100)}% of the tracked files · at the round limit the ${selfDecides(cfg) ? 'coordinator decides (advisor, then split or park; never merges)' : 'owner decides'}`,
    `confirmed: ${cfg.confirmed ? 'yes' : 'no'}`,
  ].filter(Boolean).join('\n');
}

async function cmdConfig(root, { flags }) {
  const cfg = loadConfig(root, { requireConfirmed: false });
  for (const s of flags.set) setPath(cfg, s);
  if (!['owner', 'coordinator'].includes(cfg.limits.atRoundLimit)) throw new OrchError('limits.atRoundLimit must be "owner" or "coordinator"');
  if (!['always', 'if-changed'].includes(cfg.merge.recheck)) throw new OrchError('merge.recheck must be "always" or "if-changed"');
  for (const h of cfg.harnesses ?? []) if (h.kind !== undefined && !['check', 'suite'].includes(h.kind)) throw new OrchError(`harness ${h.name}: kind must be "check" or "suite"`);
  validatePolicy(cfg.artifacts); // reject invalid assignments before they can poison the saved config
  // Merge policy: only on the owner's word. It does not unconfirm the rest of the config.
  if (typeof flags['standing-approval'] === 'string') {
    if (cfg.merge.protectedBranches.includes(cfg.baseBranch)) throw new OrchError(`${cfg.baseBranch} is protected: no standing approval for it`);
    cfg.merge.approval = 'standing'; cfg.merge.standing = { by: flags['standing-approval'], at: now() };
  }
  if (flags['owner-approval']) { cfg.merge.approval = 'owner'; cfg.merge.standing = null; }
  if (flags.confirm) {
    for (const r of ['worker', 'checker']) if (!cfg.roles[r]) throw new OrchError(`roles.${r} is not set`);
    if (!cfg.checks.length) throw new OrchError('checks is empty: the gate would only check the scope');
    cfg.confirmed = true;
  }
  if (flags.set.length || flags.confirm || flags['standing-approval'] || flags['owner-approval']) saveConfig(root, cfg);
  out(showConfig(cfg), `next: ${cfg.confirmed ? 'orch next' : 'orch config --confirm after the owner\'s ok'}`);
}

async function cmdNext(root, { flags }) {
  const cfg = loadConfig(root);
  const tracker = await trackerFor(root, cfg);
  const res = evaluate(tracker.list(), cfg, trackedFiles(root));
  const untested = untestedRuns(root);
  if (untested.length) {
    process.exitCode = 2;
    if (flags.json) { console.log(JSON.stringify({ blocked: untested.map(s => ({ id: s.id, unsafe: unresolvedUnsafe(s), untested: unresolvedUntested(s), next: nextAction(s, cfg) })), eligible: [] }, null, 2)); return; }
    out(...untested.map(s => statusLine(s, cfg)), `(no new task starts before that: ${nextAction(untested[0], cfg)})`);
    return;
  }
  const ok = res.filter(r => !r.reasons.length);
  if (flags.json) { console.log(JSON.stringify(res.map(r => ({ id: r.task.id, title: r.task.title, eligible: !r.reasons.length, reasons: r.reasons, advice: r.advice })), null, 2)); return; }
  out(ok.length ? ok.map(r => [`${r.task.id}  ${r.task.title}`, ...r.advice.map(a => `  advice: ${a}`)].join('\n')).join('\n') : 'no eligible task',
    flags.all ? res.filter(r => r.reasons.length).map(r => [`  not ${r.task.id}: ${r.reasons.join('; ')}`, ...r.advice.map(a => `    advice: ${a}`)].join('\n')).join('\n') || null : `(${res.length - ok.length} not eligible: --all shows why)`,
    `next: ${ok.length ? `orch start ${ok[0].task.id}` : 'split or unblock a task (orch next --all)'}`);
}

async function cmdStart(root, { pos, flags }) {
  const id = need(pos[0], 'task id');
  const cfg = loadConfig(root);
  const untested = untestedRuns(root);
  if (untested.length) throw new OrchError(`${untested.map(s => `${s.id} (${unresolvedUnsafe(s) ? 'unsafe merge' : 'merged result never checked'})`).join(', ')}: settle it first (orch status), then orch resolve <id> --checked "<what passed or was decided>"`);
  const tracker = await trackerFor(root, cfg);
  const task = tracker.get(id);
  if (readJson(path.join(runDir(root, task.id), 'state.json'), null)?.setAside) throw new OrchError(`${task.id} is being set aside by a split: orch card set-aside ${task.id} finishes that`);
  const ev = evaluate(tracker.list(), cfg, trackedFiles(root)).find(r => r.task.id === task.id);
  if (!ev) throw new OrchError(`${task.id} is "${task.status}", not "${cfg.tracker.status.todo}"`);
  if (ev.reasons.length && !flags.force) throw new OrchError(`${task.id} is not eligible: ${ev.reasons.join('; ')}`);
  const pr = cfg.delivery.mode === 'pr';
  if (!pr && git(['rev-parse', '--verify', '--quiet', `refs/heads/${cfg.baseBranch}`], root, { allowFail: true }).code !== 0) throw new OrchError(`base branch ${cfg.baseBranch} does not exist`);
  if (pr && gh(['repo', 'view', '--json', 'nameWithOwner'], root, { allowFail: true }).code !== 0) {
    throw new OrchError(`delivery "pr": gh cannot reach this repository on GitHub (is ${cfg.delivery.remote} a GitHub remote, and gh logged in? gh auth status)`);
  }
  // With PRs the work starts from the base branch as the remote has it, which is what the PR is merged into. Fetched
  // before the run exists: a network error leaves nothing behind.
  const base = pr ? fetchBase(root, cfg.delivery.remote, cfg.baseBranch) : git(['rev-parse', cfg.baseBranch], root);
  if (pr && remoteSha(root, cfg.delivery.remote, `${cfg.branchPrefix}${task.id}`)) {
    throw new OrchError(`${cfg.delivery.remote} already has a branch ${cfg.branchPrefix}${task.id}: an older run? look at it, delete it or park the task`);
  }

  const dir = runDir(root, task.id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(dir); } catch (e) {
    if (e.code === 'EEXIST') throw new OrchError(`${task.id} already has a run: orch status ${task.id}`);
    throw e;
  }
  const branch = `${cfg.branchPrefix}${task.id}`;
  const worktree = path.resolve(root, cfg.worktreeRoot, `orch-${task.id}`);
  try {
    git(['worktree', 'add', '-q', '-b', branch, worktree, base], root);
  } catch (e) { fs.rmSync(dir, { recursive: true }); throw e; }
  const links = [];
  for (const l of cfg.links) {
    const src = path.join(root, l);
    if (fs.existsSync(src) && !fs.existsSync(path.join(worktree, l))) {
      fs.symlinkSync(src, path.join(worktree, l)); links.push(l);
      excludeOnce(root, `/${l}`); // "node_modules/" in .gitignore matches directories only, not the symlink
    }
  }
  const st = {
    id: task.id, title: task.title, branch, worktree, base, baseBranch: cfg.baseBranch, links, delivery: cfg.delivery.mode,
    phase: 'working', round: 0, gate: null, verdicts: [], checkerPrompts: [], events: [],
    forced: ev.reasons.length ? ev.reasons : undefined,
  };
  st.prompt = writeWorkerPrompt(root, cfg, task, st);
  event(st, 'start', { base: base.slice(0, 9) });
  saveState(root, st);
  tracker.setStatus(task.id, cfg.tracker.status.inProgress);
  tracker.comment(task.id, `started: branch ${branch} from ${cfg.baseBranch} ${base.slice(0, 9)}${st.forced ? ' (forced)' : ''}`);
  out(`started ${task.id}: worktree ${worktree}, branch ${branch} from ${cfg.baseBranch} ${base.slice(0, 9)}`,
    ...ev.advice.map(a => `advice: ${a} (tell the owner; the gate will report it too)`), `next: ${nextAction(st, cfg)}`);
}

function writeWorkerPrompt(root, cfg, task, st) {
  const file = path.join(runDir(root, st.id), 'prompts', `worker-r${st.round}.md`);
  writeAtomic(file, workerBrief(root, cfg, task, st));
  return file;
}

function workerBrief(root, cfg, task, st) {
  const notesFile = path.join(orchDir(root), 'NOTES.md');
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim().slice(0, 4000) : '';
  return fill(tpl('worker'), {
    notes: notes || '(none)',
    id: task.id, title: task.title, worktree: st.worktree, branch: st.branch, base: st.base.slice(0, 9),
    description: task.description || '(no description in the task)', acceptance: task.acceptance || '(none)',
    plan: task.plan || '(none)', owned: block(task.ownedFiles), checks: block(checksFor(cfg, task)),
    tests: testsBrief(cfg, task),
    trackerDir: cfg.tracker.dir ?? '.orchestrate', reportPath: path.join(runDir(root, st.id), 'inbox', 'worker.md'),
  });
}

function testsBrief(cfg, task) {
  const hs = harnessesCovering(cfg, task);
  const lines = hs.length
    ? hs.map(h => {
      const specs = focusedSpecs(task);
      if (isCheck(h)) return `- Check ${h.name}: the gate runs \`${h.command}\` when you change ${(h.paths ?? ['**']).join(', ')}; run it yourself before you report only if you changed those files.`;
      const atGate = h.fast
        ? `the gate runs your spec files plus the critical ones (${(h.fast.critical ?? []).join(', ') || 'none'}), and the whole suite only for a closure card or when you change ${(cfg.risk?.paths ?? []).join(', ') || 'risky paths'}`
        : `the gate runs the whole suite (\`${h.command}\`)`;
      return `- Harness ${h.name}: ${atGate}, when you change ${(h.paths ?? ['**']).join(', ')}. `
        + `Do not run the whole suite yourself, even if the project notes or the task ask for "the E2E harness": run only the specs that cover your change, e.g. \`${h.command} ${specs.length ? specs.join(' ') : '<spec files>'}\``
        + `${specs.length ? ' (the spec files you own)' : ''}, and quote the result.`;
    })
    : ['- No end-to-end harness covers these files.'];
  if (hs.length && hs.every(isCheck)) lines.push('- No end-to-end harness covers these files.');
  const rules = cardRules(task, cfg);
  if (rules) lines.push(rules);
  if (task.noTests) lines.push(`- The owner says this task needs no new test: ${task.noTests}`);
  else if (cfg.tests.rule !== 'off') {
    lines.push(`- If you change behaviour, add or update a test that fails before your change and passes after, in a file you own (test files: ${cfg.tests.paths.join(', ')}). A source change with no test change is ${cfg.tests.rule === 'fail' ? 'a gate FAIL' : 'reported by the gate'}; if no test makes sense, say why in the report.`);
  }
  return lines.join('\n');
}

// A harness's last whole run that passed: runs/_suite-<name>.json, and for a suite (not kind "check") also the older
// runs/_suite.json that earlier releases read.
const suiteMarker = (root, h) => path.join(orchDir(root), 'runs', `_suite-${String(h.name).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const isCheck = h => h?.kind === 'check';

/** The cards merged into the base branch since the last whole-suite pass of a harness, to find which one broke it. */
// What decides a verdict besides the tree: the checks and harness definitions. A merge may skip its checks on an
// identical tree only while this is unchanged since the gate.
function checksHash(cfg, task) {
  return createHash('sha256').update(JSON.stringify({ checks: checksFor(cfg, task), harnesses: cfg.harnesses })).digest('hex').slice(0, 16);
}

function mergedSinceGreen(root, cfg, h) {
  const green = readJson(suiteMarker(root, h), null) ?? (isCheck(h) ? null : readJson(path.join(orchDir(root), 'runs', '_suite.json'), null));
  if (!green?.base) return 'no whole-suite pass recorded yet: compare with the cards merged today';
  const r = git(['log', '--merges', '--format=%s', `${green.base}..${cfg.baseBranch}`], root, { allowFail: true });
  // The green run was on that card's own tree: only the cards merged after it can have broken the suite.
  const cards = r.code === 0
    ? r.out.split('\n').map(s => s.match(/^Merge orch\/([^:\s]+)/)?.[1]).filter(c => c && c !== green.card)
    : [];
  return `last whole-suite pass${isCheck(h) ? ` of ${h.name}` : ''}: ${green.card} (${green.at}); cards merged into ${cfg.baseBranch} since: ${cards.length ? cards.reverse().join(', ') : 'none'}`;
}

/** The e2e spec files a task owns (literal spec/test paths, or globs naming them), to keep workers and checkers on them. */
export function focusedSpecs(task) {
  return task.ownedFiles.filter(g => /\.(spec|test)\.[a-z]+$/i.test(g) || /(^|\/)(e2e|tests?)\/[^*]*\*?\.?(spec|test)/i.test(g)).slice(0, 8);
}

async function cmdRecord(root, { pos, flags }) {
  const id = need(pos[0], 'task id'); const role = need(pos[1], 'worker|checker');
  if (!['worker', 'checker'].includes(role)) throw new OrchError('role must be worker or checker');
  const cfg = loadConfig(root);
  const st = activeState(root, id);
  const tag = role === 'checker' ? String(flags.tag ?? 'a') : null;
  // A checker writes checker-r<round>-<tag>.md; checker-<tag>.md is the name briefs of older releases still use.
  const box = n => path.join(runDir(root, st.id), 'inbox', n);
  const inbox = role === 'worker' ? box('worker.md')
    : !fs.existsSync(box(`checker-r${st.round}-${tag}.md`)) && fs.existsSync(box(`checker-${tag}.md`)) && legacyCheckerName(root, st, tag) ? box(`checker-${tag}.md`) : box(`checker-r${st.round}-${tag}.md`);
  const src = flags.from ? path.resolve(flags.from) : inbox;
  if (!fs.existsSync(src)) throw new OrchError(`no report at ${src}: if the sub-agent only answered in chat, save its answer there (or pass --from <file>)`);
  // Every check before the report leaves the inbox: a refused record keeps it where it was.
  if (role === 'worker' && st.phase !== 'working') throw new OrchError(`${st.id} is in phase ${st.phase}, not waiting for a worker`);
  if (role === 'checker') {
    if (!['checking', 'ready', 'rejected'].includes(st.phase)) throw new OrchError(`${st.id} is in phase ${st.phase}: checkers come after a gate PASS`);
    if (stageAndTree(st.worktree) !== st.gate.tree) throw new OrchError('the worktree changed after the gate: the checker saw another state. Run orch gate again');
  }
  if (!flags.from && path.basename(inbox) !== `checker-r${st.round}-${tag}.md` && ['working', 'checking'].includes(st.phase) && fs.statSync(src).mtimeMs < phaseOpenedAt(st) - 1000) {
    throw new OrchError(`the report in ${src} is older than this round (${st.phase === 'working' ? 'its start' : 'its gate'}): a leftover of an earlier round. Wait for this round's ${role}, or pass --from <file> if you are sure`);
  }
  const text = fs.readFileSync(src, 'utf8');
  const dest = path.join(runDir(root, st.id), 'reports', `r${st.round}-${role}${tag ? `-${tag}` : ''}.md`);
  if (fs.existsSync(dest)) setAsideFile(root, st, dest); // a second record of the same round and role keeps the first
  writeAtomic(dest, text);
  if (src === inbox) fs.rmSync(inbox);
  // The older name for the same checker, if both exist, is not this record's: set aside so it is never taken later.
  if (tag && fs.existsSync(box(`checker-${tag}.md`)) && path.basename(src) !== `checker-${tag}.md`) setAsideFile(root, st, box(`checker-${tag}.md`));
  const tokens = flags.tokens ? Number(flags.tokens) : undefined;
  const tracker = await trackerFor(root, cfg);

  if (role === 'worker') {
    st.phase = 'worked';
    event(st, 'worker', { round: st.round, tokens });
    saveState(root, st);
    out(`recorded the worker report (round ${st.round}, ${text.split('\n').length} lines)`, `next: ${nextAction(st, cfg)}`);
    return;
  }
  const tree = st.gate.tree;
  const m = [...text.matchAll(/VERDICT:\s*\**\s*(PASS WITH NOTES|PASS|FAIL|NEEDS EVIDENCE)/gi)].at(-1);
  let verdict = m ? m[1].toUpperCase().replace('PASS WITH NOTES', 'PASS') : 'NEEDS EVIDENCE';
  const executed = (text.match(/^\s*[-*]?\s*`?EXECUTED:/gm) ?? []).length;
  let note = m ? '' : ' (no VERDICT line)';
  if (verdict === 'PASS' && executed === 0) { verdict = 'NEEDS EVIDENCE'; note = ' (PASS without EXECUTED lines)'; }
  st.verdicts = st.verdicts.filter(v => !(v.round === st.round && v.tag === tag));
  st.verdicts.push({ round: st.round, tag, verdict, executed, tree, file: dest });
  event(st, 'checker', { round: st.round, tag, verdict, executed, tokens });
  const cur = currentVerdicts(st);
  st.phase = cur.some(v => v.verdict !== 'PASS') ? 'rejected' : cur.length >= cfg.limits.checkers ? 'ready' : 'checking';
  saveState(root, st);
  tracker.comment(st.id, `checker ${tag} round ${st.round}: ${verdict}${note}, ${executed} executed`);
  if (st.delivery === 'pr' && st.sha) postStatus(root, st.sha, `orch/checker-${tag}`, verdict === 'PASS' ? 'success' : 'failure', `round ${st.round}: ${verdict}, ${executed} executed`);
  out(`checker ${tag}: ${verdict}${note}, ${executed} EXECUTED line(s)`, `next: ${nextAction(st, cfg)}`);
}

async function cmdGate(root, { pos }) {
  const id = need(pos[0], 'task id');
  const cfg = loadConfig(root);
  const st = activeState(root, id);
  if (['merged', 'parked'].includes(st.phase)) throw new OrchError(`${st.id} is ${st.phase}`);
  process.env.ORCH_RUN = `${st.id} r${st.round}`; // the commands' artifact scopes belong to this run (their cleanup)
  const tracker = await trackerFor(root, cfg);
  const task = tracker.get(st.id);
  const dir = runDir(root, st.id);
  const wt = st.worktree;
  const t0 = Date.now();
  const lines = []; let fail = false; let infra = null;
  const pass = s => lines.push(`PASS  ${s}`);
  const bad = s => { lines.push(`FAIL  ${s}`); fail = true; };
  const warn = s => lines.push(`WARN  ${s}`);
  if (st.phase === 'working') warn('the worker report was not recorded (orch record … worker)');

  const tree = stageAndTree(wt);
  const commits = Number(git(['rev-list', '--count', `${st.sha ?? st.base}..HEAD`], wt)); // orch's own pushed commits do not count
  if (commits) warn(`the worker made ${commits} commit(s); they are counted with the rest`);
  const files = git(['diff', '--cached', '--no-renames', '--name-only', st.base], wt).split('\n').filter(Boolean);
  let added = 0; let removed = 0;
  for (const l of git(['diff', '--cached', '--no-renames', '--numstat', st.base], wt).split('\n').filter(Boolean)) {
    const [a, r] = l.split('\t'); added += Number(a) || 0; removed += Number(r) || 0;
  }
  if (!files.length) bad('nothing changed against the base');

  const owned = task.ownedFiles;
  // A tracker kept in the repository (Backlog.md) is the coordinator's, never the worker's.
  const notOwned = [...(cfg.tracker.dir ? [`${cfg.tracker.dir}/**`] : []), '.orchestrate/**'];
  const outside = files.filter(f => !matchesAny(owned, f) || matchesAny(notOwned, f));
  if (!owned.length) bad('the task has no modified_files');
  else if (outside.length) bad(`scope: ${outside.length} file(s) outside the owned files: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ' …' : ''}`);
  else pass(`scope: all ${files.length} changed file(s) are owned`);

  const addedText = git(['diff', '--cached', '-U0', st.base], wt).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|(password|secret|api_?key|token)\w*\s*[:=]\s*["']?[A-Za-z0-9/+_-]{24,}/i.test(addedText)) {
    warn('secrets: an added line looks like a credential, read it before the merge');
  }

  const checks = checksFor(cfg, task);
  let checksPassed = 0;
  checks.forEach((cmd, i) => {
    const r = sh(cmd, { cwd: wt, timeoutSec: cfg.limits.checkTimeoutSec });
    writeAtomic(path.join(dir, 'logs', `gate-r${st.round}-check-${i + 1}.log`), `$ ${cmd}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
    if (r.infra) { infra ??= r.infra; lines.push(`INFRA check ${i + 1}: ${cmd} -> ${r.infra}`); }
    else if (r.code === 0) { checksPassed++; pass(`check ${i + 1}: ${cmd} (${minutes(r.ms)})`); }
    else bad(`check ${i + 1}: ${cmd} -> exit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}: ${lastLines(r.out, 3).replace(/\s*\n\s*/g, ' | ').slice(0, 300)}`);
  });
  const rule = testRule(cfg, task, files);
  if (rule.level === 'pass') pass(rule.text); else if (rule.level === 'warn') warn(rule.text); else if (rule.level === 'fail') bad(rule.text);

  // A closure card (other cards name it as their parent) runs every gate harness in full, whatever it touched.
  const closure = tracker.list().some(t => t.parent && t.parent.toUpperCase() === task.id.toUpperCase());
  const risky = riskyFiles(cfg, files);
  const harnesses = closure ? cfg.harnesses.filter(h => (h.when ?? 'gate') === 'gate') : harnessesFor(cfg, task, files, 'gate');
  const worktreeFiles = harnesses.some(h => h.fast) ? git(['ls-files', '-co', '--exclude-standard'], wt).split('\n').filter(Boolean) : [];
  // A harness the change does not reach is skipped, and said so (never silent). It is not in harnessRuns: an earlier
  // release's merge would read any entry there as a whole run.
  for (const h of cfg.harnesses.filter(h => (h.when ?? 'gate') === 'gate' && !harnesses.includes(h))) {
    lines.push(`SKIP  harness ${h.name}: no changed file under its paths (${(h.paths ?? ['**']).slice(0, 4).join(', ')}${(h.paths ?? []).length > 4 ? ' …' : ''})`);
  }
  const harnessRuns = [];
  let harnessPassed = 0;
  // Fail fast: when the scope, a check or the test rule already fails the gate, a harness run (minutes for a whole
  // suite) cannot change the verdict, and the next round runs it again anyway.
  const failedBefore = fail || infra;
  for (const h of harnesses) {
    if (failedBefore || infra) { lines.push(`SKIP  harness ${h.name}: not run, the gate already fails above (it runs once the rest passes)`); continue; }
    const plan = harnessPlan(h, { closure, risky, specs: cardSpecFiles(h, task, files, worktreeFiles) });
    const run = { name: h.name, mode: plan.mode, specs: plan.specs };
    harnessRuns.push(run);
    if (plan.mode === 'skip') { harnessPassed++; pass(`harness ${h.name}: fast gate, nothing to run (${plan.reason})`); continue; }
    const command = plan.mode === 'full' ? h.command : `${h.command} ${plan.specs.map(shq).join(' ')}`;
    const log = path.join(dir, 'logs', `gate-r${st.round}-harness-${h.name}.log`);
    let r = runHarness(root, { ...h, command }, wt);
    run.ms = r.ms;
    writeAtomic(log, `$ ${command}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
    let flaky = [];
    if (r.infra) { infra ??= r.infra; lines.push(`INFRA harness ${h.name} (${plan.mode}): ${command} -> ${r.infra}`); continue; }
    if (r.code !== 0 && plan.mode === 'full' && !r.timedOut) {
      // One rerun of the failed specs alone: a shared test database makes some failures noise, not regressions.
      const failed = failedSpecFiles(r.out);
      if (failed.length) {
        const again = `${h.command} ${failed.map(shq).join(' ')}`;
        const r2 = runHarness(root, { ...h, command: again }, wt);
        fs.appendFileSync(log, `\n\n$ ${again}   (rerun of the failed specs)\nexit ${r2.code} in ${minutes(r2.ms)}\n\n${r2.out}`);
        if (r2.infra) { infra ??= r2.infra; lines.push(`INFRA harness ${h.name} (rerun of the failed specs) -> ${r2.infra}`); continue; }
        if (r2.code === 0) { flaky = failed; r = { ...r, code: 0 }; }
      }
    }
    const label = `harness ${h.name} (${plan.mode}${plan.reason ? `: ${plan.reason}` : ''})`;
    if (r.code === 0) {
      harnessPassed++;
      pass(`${label}: ${command} (${minutes(r.ms)})`);
      if (flaky.length) warn(`flaky: ${flaky.join(', ')} failed in the full run and passed on a rerun`);
      if (plan.mode === 'full') {
        const green = { base: st.base, card: st.id, harness: h.name, at: now() };
        writeJson(suiteMarker(root, h), green);
        if (!isCheck(h)) writeJson(path.join(orchDir(root), 'runs', '_suite.json'), green);
      }
    } else {
      bad(`${label}: ${command} -> exit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}: ${lastLines(r.out, 4).replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`);
      if (plan.mode === 'full') lines.push(`INFO  ${mergedSinceGreen(root, cfg, h)}`);
    }
  }
  const later = harnessesFor(cfg, task, files, 'merge');
  if (later.length) pass(`harness ${later.map(h => h.name).join(', ')}: runs at the merge`);
  if (stageAndTree(wt) !== tree) bad('the checks or harnesses changed files in the worktree (a formatter, a generator, a report folder not ignored?): run them in the worker, not in the gate');

  if (infra) {
    // The machine ended a command (out of memory, killed): no verdict on the change, no correction round used.
    const text = [`gate ${st.id} round ${st.round}: ${files.length} file(s), +${added} -${removed}`, ...lines, '', 'GATE: INFRA (no verdict, not a correction round)'].join('\n');
    writeAtomic(path.join(dir, `gate-r${st.round}.txt`), `${text}\n`);
    st.phase = 'worked';
    event(st, 'gate-infra', { round: st.round, reason: infra, ms: Date.now() - t0 });
    saveState(root, st);
    out(text, `next: inspect the infrastructure log (${infra}); retry orch gate ${st.id} only after recovery; if it repeats, stop and tell the owner`);
    process.exitCode = 3;
    return;
  }
  delete st.mergedTree; // a new gate is on the worker's tree, not on an earlier base merge
  st.gate = {
    pass: !fail, tree, files: files.length, added, removed, checksRun: checks.length, checksPassed,
    harnessesRun: harnesses.length, harnessesPassed: harnessPassed, harnessRuns, tests: rule.level, round: st.round, at: now(),
    cfgHash: checksHash(cfg, task),
  };
  const text = [`gate ${st.id} round ${st.round}: ${files.length} file(s), +${added} -${removed}`, ...lines, '', `GATE: ${fail ? 'FAIL' : 'PASS'}`].join('\n');
  writeAtomic(path.join(dir, `gate-r${st.round}.txt`), `${text}\n`);
  event(st, 'gate', { round: st.round, pass: !fail, files: files.length, added, removed, ms: Date.now() - t0 });
  if (!fail && st.delivery === 'pr') st.phase = 'gated'; // the checker comes after the push: it gets the PR and the sha
  else if (!fail) {
    st.phase = 'checking';
    setAsideInbox(root, st, n => n.startsWith('checker-'));
    st.checkerPrompts = writeCheckerPrompts(root, cfg, task, st, text);
    tracker.setStatus(st.id, cfg.tracker.status.inCheck);
  } else st.phase = 'gate-failed';
  saveState(root, st);
  tracker.comment(st.id, `gate round ${st.round}: ${fail ? 'FAIL' : 'PASS'}, ${files.length} files +${added} -${removed}, checks ${checksPassed}/${checks.length}`);
  out(text, `next: ${nextAction(st, cfg)}`);
  process.exitCode = fail ? 2 : 0;
}

function writeCheckerPrompts(root, cfg, task, st, gateText) {
  const tags = 'abcdefgh'.slice(0, Math.max(1, cfg.limits.checkers)).split('');
  return tags.map(tag => {
    const prompt = path.join(runDir(root, st.id), 'prompts', `checker-r${st.round}-${tag}.md`);
    writeAtomic(prompt, fill(tpl('checker'), {
      id: st.id, title: st.title, worktree: st.worktree, base: st.base, round: st.round,
      gateSummary: gateText.split('\n').map(l => `    ${l}`).join('\n'),
      description: task.description || '(no description)', acceptance: task.acceptance || '(none)', owned: block(task.ownedFiles),
      harnesses: checkerHarnesses(cfg, task, st),
      reportPath: path.join(runDir(root, st.id), 'inbox', `checker-r${st.round}-${tag}.md`), // per round: a late checker of an earlier round never passes for this one
    }));
    return { tag, prompt };
  });
}

function checkerHarnesses(cfg, task, st) {
  const hs = harnessesCovering(cfg, task);
  const specs = focusedSpecs(task);
  const rules = cardRules(task, cfg, 'checker');
  return [
    ...(rules ? [rules] : []),
    `The gate already ran these on this exact tree (orch refuses a verdict if the tree changed since): ${[
      ...checksFor(cfg, task),
      ...(st.gate?.harnessRuns ?? hs.map(h => ({ name: h.name, mode: 'full', specs: [] }))).map((x) => {
        const h = cfg.harnesses.find(y => y.name === x.name);
        const cmd = h ? h.command : x.name;
        return x.mode === 'full' ? `\`${cmd}\` (${isCheck(h) ? 'scoped check' : 'whole suite'})` : x.mode === 'fast' ? `\`${cmd} ${x.specs.join(' ')}\` (fast gate)` : `${x.name}: nothing to run`;
      }),
    ].join(', ')}.`,
    ...(() => { const skipped = (cfg.harnesses ?? []).filter(h => (h.when ?? 'gate') === 'gate' && st.gate?.harnessRuns && !st.gate.harnessRuns.some(x => x.name === h.name)); return skipped.length ? [`Not run at the gate (the change does not reach their paths): ${skipped.map(h => h.name).join(', ')}.`] : []; })(),
    'Do not run the whole e2e suite again, even if the project notes ask for the E2E harness. Run the checks that are fast, and the harness only on the specs that cover',
    `the change${(() => { const e2e = hs.find(h => !isCheck(h)); return e2e ? `, e.g. \`${e2e.command} ${specs.length ? specs.join(' ') : '<spec files>'}\`` : ''; })()} (in \`${st.worktree}\`).`,
    'Then test what they do not cover: for a page or flow the task changes, run the harness on the spec for that page',
    '(or write a throwaway one outside the repository) and quote it. If the change alters behaviour, check that a test',
    'covers it and that the test fails without the change (for example by running it on the base commit).',
  ].join('\n');
}

async function cmdFix(root, { pos }) {
  const id = need(pos[0], 'task id');
  const cfg = loadConfig(root);
  const st = activeState(root, id);
  if (!['gate-failed', 'rejected'].includes(st.phase)) throw new OrchError(`${st.id} is in phase ${st.phase}: a fix follows a failed gate or a rejecting checker`);
  if (st.round >= cfg.limits.correctionRounds) throw new OrchError(nextAction(st, cfg), 3);
  const tracker = await trackerFor(root, cfg);
  const task = tracker.get(st.id);
  const dir = runDir(root, st.id);
  const findings = [];
  if (st.phase === 'gate-failed') {
    const gate = fs.readFileSync(path.join(dir, `gate-r${st.round}.txt`), 'utf8');
    findings.push('### The gate', gate.split('\n').filter(l => /^(FAIL|WARN)/.test(l)).join('\n'),
      `(full check output: ${path.join(dir, 'logs')})`);
  } else {
    for (const v of currentVerdicts(st).filter(x => x.verdict !== 'PASS')) {
      findings.push(`### Checker ${v.tag}: ${v.verdict}`, fs.readFileSync(v.file, 'utf8').slice(0, 6000));
    }
  }
  setAsideInbox(root, st);
  st.round += 1;
  const file = path.join(dir, 'prompts', `fix-r${st.round}.md`);
  writeAtomic(file, fill(tpl('fix'), {
    id: st.id, round: st.round, maxRounds: cfg.limits.correctionRounds, worktree: st.worktree,
    findings: findings.join('\n\n'), reportPath: path.join(dir, 'inbox', 'worker.md'),
    workerBrief: workerBrief(root, cfg, task, st),
  }));
  st.prompt = file; st.phase = 'working';
  event(st, 'fix', { round: st.round });
  saveState(root, st);
  cleanRun(root, cfg, st.id); // the rounds before the last two
  tracker.setStatus(st.id, cfg.tracker.status.inProgress);
  tracker.comment(st.id, `correction round ${st.round}/${cfg.limits.correctionRounds}`);
  out(`round ${st.round}/${cfg.limits.correctionRounds}: ${file}`, `next: ${nextAction(st, cfg)}`);
}

async function cmdFinish(root, { pos, flags }) {
  const id = need(pos[0], 'task id');
  const cfg = loadConfig(root);
  const given = typeof flags['approved-by'] === 'string' ? flags['approved-by'] : null;
  const override = typeof flags.override === 'string' ? flags.override : null;
  if (cfg.merge.protectedBranches.includes(cfg.baseBranch) && !given) {
    throw new OrchError(`${cfg.baseBranch} is a protected branch: every merge needs --approved-by <the owner who said ok>`);
  }
  if (override && !given) throw new OrchError('--override accepts work without a checker PASS: it always needs --approved-by <the owner who said ok for this task>');
  // The coordinator decides at the round limit without the owner, so nothing it runs may merge work that did not pass.
  if (override && selfDecides(cfg)) throw new OrchError('limits.atRoundLimit is "coordinator": no --override, a card is merged only after a gate PASS and a checker PASS. To accept it anyway the owner sets limits.atRoundLimit=owner and confirms the config first');
  const who = given ?? (standingApproval(cfg) ? `standing approval of ${cfg.merge.standing.by} (${cfg.merge.standing.at})` : null);
  if (!who) throw new OrchError('finish merges: it needs --approved-by <the owner who said ok> (no standing approval in the config)');
  const st = activeState(root, id);
  process.env.ORCH_RUN = `${st.id} r${st.round}`; // the merge checks' artifact scopes belong to this run
  // A finish that stopped after the merge commit (killed, timed out, tracker down) resumes at the step it missed.
  if (st.phase === 'merged') {
    if (!st.finishPending?.length) throw new OrchError(`${st.id} is already merged`);
    return completeFinish(root, cfg, st, await trackerFor(root, cfg), ['resumed an interrupted finish']);
  }
  if (st.delivery === 'pr') return finishPr(root, cfg, st, who, override);
  // On the base branch only: a merge of this branch into another one (a try-out branch) is not the card's merge.
  const current = git(['branch', '--show-current'], root);
  if (current !== st.baseBranch) throw new OrchError(`the main checkout is on ${current || '(detached)'}, not ${st.baseBranch}: orch does not switch branches for you`);
  const recovered = recoverInterruptedMerge(root, st);
  if (recovered.merged) return completeFinish(root, cfg, st, await trackerFor(root, cfg), recovered.notes);
  if (!st.gate?.pass) throw new OrchError(`${st.id} has no passing gate: never merged`);
  if (stageAndTree(st.worktree) !== st.gate.tree) throw new OrchError('the worktree changed after the gate: run orch gate again');
  if (st.phase !== 'ready' && !override) throw new OrchError(`${st.id} is in phase ${st.phase}, not ready: the checkers have not all passed (--override "<why>" only with the owner's ok)`);
  if (git(['diff', '--cached', '--quiet'], root, { allowFail: true }).code !== 0) throw new OrchError('the main checkout has staged changes: they would end up in the merge commit. Look at git status; if they are left over from an interrupted merge (not someone\'s work), git reset --merge clears them');
  const tracker = await trackerFor(root, cfg);

  // The worker's result becomes one commit on the task branch, made from the gated tree itself: a commit hook in the
  // worktree cannot change or block what was checked. Reused when HEAD already has that tree (a rerun).
  const wtHead = git(['rev-parse', 'HEAD'], st.worktree);
  if (git(['rev-parse', `${wtHead}^{tree}`], st.worktree) !== st.gate.tree) {
    // Signed like a plain commit would be when the user signs commits (commit-tree does not read commit.gpgsign).
    const sign = git(['config', '--bool', 'commit.gpgsign'], st.worktree, { allowFail: true }).out === 'true' ? ['-S'] : [];
    const sha = git(['commit-tree', ...sign, st.gate.tree, '-p', wtHead, '-m', `${st.id}: ${st.title}`], st.worktree);
    git(['reset', '-q', '--soft', sha], st.worktree);
  }
  const m = git(['merge', '--no-ff', '--no-commit', st.branch], root, { allowFail: true });
  if (m.code !== 0) {
    const stuck = abortMerge(root);
    throw new OrchError(`merge of ${st.branch} into ${st.baseBranch} does not apply cleanly: ${(m.err || m.out).split('\n')[0]}. Nothing was merged.${stuck}`);
  }
  // The checks again, on the merged result, before the merge commit exists. Harnesses: the "merge" ones, and the
  // "gate" ones too when the base branch moved since the start (the merged tree is then not the gated tree).
  const t0 = Date.now();
  const task = tracker.get(st.id);
  const changed = git(['diff', '--no-renames', '--name-only', st.base, st.branch], root).split('\n').filter(Boolean);
  const head = git(['rev-parse', 'HEAD'], root);
  const inert = head !== st.base && baseChangeInert(root, cfg, st.base, head);
  const moved = head !== st.base && !inert;
  const same = identicalToGate(root, cfg, st, task, root);
  if (same.same) recovered.notes.push(`the merged tree is the gated one${same.files.length ? ` (plus ${same.files.length} inert file(s))` : ''}: checks and gate harnesses not repeated (merge.recheck if-changed)`);
  else if (inert) recovered.notes.push(`${st.baseBranch} moved only in ${inert}: the gate's harnesses were not repeated (project checks ran)`);
  const runs = mergeRuns(root, cfg, st, task, changed, moved, root, { lean: same.same });
  for (const x of runs) {
    const r = x.run();
    writeAtomic(path.join(runDir(root, st.id), 'logs', x.log), `${x.label}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
    if (r.code !== 0) {
      const stuck = abortMerge(root);
      event(st, 'merge-check', { pass: false, what: x.label }); saveState(root, st);
      if (r.infra) throw new OrchError(`${x.label} was stopped by the machine on the merged result (${r.infra}). ${stuck || ` Merge aborted, nothing changed on ${st.baseBranch}: run orch finish ${st.id} again.`}`, 3);
      throw new OrchError(`${x.label} fails on the merged result (exit ${r.code}): ${lastLines(r.out, 2).replace(/\n/g, ' | ')}.${stuck || ` Merge aborted, nothing changed on ${st.baseBranch}.`}`, 2);
    }
  }
  // On record before the commit: what was merged and whether its checks were skipped, so a recovery can tell a merge
  // a commit hook changed.
  st.mergeIntent = { tree: same.tree, skipped: same.same }; saveState(root, st);
  const c = git(['commit', '-q', '-m', `Merge ${st.branch}: ${st.id} ${st.title}`, '-m', `Approved by ${who}.${override ? ` Accepted without a checker PASS: ${override}` : ''}`], root, { allowFail: true });
  if (c.code !== 0) {
    const stuck = abortMerge(root);
    throw new OrchError(`the merge commit was refused (a git hook?): ${(c.err || c.out).split('\n')[0]}.${stuck || ` Merge aborted, nothing changed on ${st.baseBranch}.`}`, 2);
  }
  const merged = git(['rev-parse', 'HEAD'], root);
  // A commit hook changed the merged files: what is on the base is not what was checked. Recorded, never rewritten.
  if (git(['rev-parse', `${merged}^{tree}`], root) !== same.tree) {
    st.untestedMerge = true;
    recovered.notes.push(`a commit hook changed the merge ${merged.slice(0, 9)}: the merged files are not the checked ones; run the checks on ${st.baseBranch}, then orch resolve ${st.id} --checked "<what passed>"`);
  }
  st.phase = 'merged'; st.merge = merged; st.approvedBy = who; st.override = override ?? undefined;
  st.finishPending = ['tracker', 'cleanup'];
  event(st, 'merge', { sha: merged.slice(0, 9), checksMs: Date.now() - t0 });
  saveState(root, st); // the merge is on record before anything else can fail
  return completeFinish(root, cfg, st, tracker, recovered.notes);
}

// delivery pr, after a gate PASS: the remote branch gets one commit whose tree is exactly the gated tree and whose
// parent is the previous push (or the base): the worker's own intermediate commits never leave the machine, and the
// PR's history only grows. Never over someone else's push; a push that already happened before an interruption is
// recognised as orch's own. Then the PR is opened or updated and the checkers are briefed with its sha.
async function cmdPush(root, { pos }) {
  const id = need(pos[0], 'task id');
  const cfg = loadConfig(root);
  const st = activeState(root, id);
  if (st.delivery !== 'pr') throw new OrchError(`${st.id} merges locally (delivery "${st.delivery ?? 'local'}"): there is nothing to push`);
  if (st.phase !== 'gated') throw new OrchError(`${st.id} is ${st.phase}: push follows a gate PASS (orch gate ${st.id})`);
  const remote = cfg.delivery.remote;
  const tracker = await trackerFor(root, cfg);
  const task = tracker.get(st.id);
  const wt = st.worktree;
  if (stageAndTree(wt) !== st.gate.tree) throw new OrchError('the worktree changed after the gate: run orch gate again');
  const parent = st.sha ?? st.base;
  const isOurs = c => git(['rev-parse', `${c}^{tree}`], wt) === st.gate.tree && git(['rev-parse', `${c}^1`], wt, { allowFail: true }).out === parent;
  let sha = null;
  const there = remoteSha(root, remote, st.branch);
  if (there && there !== (st.sha ?? null)) {
    git(['fetch', '-q', remote, `refs/heads/${st.branch}`], wt, { allowFail: true });
    if (git(['cat-file', '-e', `${there}^{commit}`], wt, { allowFail: true }).code === 0 && isOurs(there)) sha = there; // pushed before an interruption
  }
  const head = git(['rev-parse', 'HEAD'], wt);
  if (!sha && head !== parent && isOurs(head)) sha = head; // made before an interruption, not pushed yet
  sha ??= git(['commit-tree', st.gate.tree, '-p', parent, '-m', `${st.id}: ${st.title}${st.round ? ` (round ${st.round})` : ''}`], wt);
  git(['reset', '-q', '--soft', sha], wt); // the task branch is that commit; the index already holds its tree
  pushExact(wt, root, remote, st.branch, sha, st.sha ?? null);
  st.sha = sha; event(st, 'push', { sha: sha.slice(0, 9), round: st.round }); saveState(root, st); // pushed: on record first
  const gateText = fs.readFileSync(path.join(runDir(root, st.id), `gate-r${st.round}.txt`), 'utf8');
  const body = redactSecrets([
    (task.description || st.title).slice(0, 3000), '',
    `Gate round ${st.round} on this commit:`, '```', gateText.trim().split('\n').filter(l => /^(PASS|WARN|FAIL|SKIP|INFRA|GATE)/.test(l)).join('\n'), '```', '',
    'Opened by orch (the orchestrate skill). Merged only with the owner\'s consent.',
  ].join('\n'));
  const pr = ensurePr(root, { branch: st.branch, base: st.baseBranch, title: `${st.id}: ${st.title}`, body });
  postStatus(root, sha, 'orch/gate', 'success', `gate round ${st.round}: PASS`);
  st.pr = { number: pr.number, url: pr.url };
  st.phase = 'checking';
  setAsideInbox(root, st, n => n.startsWith('checker-'));
  st.checkerPrompts = writeCheckerPrompts(root, cfg, task, st, `${gateText.trim()}\n\nPushed as ${sha} in PR ${pr.url} (the same tree as this worktree).`);
  saveState(root, st);
  tracker.setStatus(st.id, cfg.tracker.status.inCheck);
  tracker.comment(st.id, `round ${st.round}: pushed ${sha.slice(0, 9)}, PR ${pr.url}`);
  out(`pushed ${st.id} ${sha.slice(0, 9)} · PR #${pr.number} ${pr.url}${pr.created ? ' (opened)' : ' (updated)'}`, `next: ${nextAction(st, cfg)}`);
}

// The tree a pr run's worktree must hold at finish: the gated one, or the result of merging the moved base into it.
const expectedTree = st => st.mergedTree ?? st.gate.tree;

// delivery pr: merge the PR on GitHub, only at the sha that was gated, pushed and checked, and only into the base
// branch of the run. When the base moved, it is merged into the task branch first (each time it moves, at most three)
// and the checks run on that result here, as a local finish does. Every step is recorded before it acts, so a finish
// stopped anywhere runs again from where it was.
async function finishPr(root, cfg, st, who, override) {
  const remote = cfg.delivery.remote;
  const tracker = await trackerFor(root, cfg);
  const wt = st.worktree;
  const notes = [];
  if (!st.pr || !st.sha) throw new OrchError(`${st.id} has no PR yet: orch push ${st.id}`);
  if (st.unsafeMerge) {
    if (st.unsafeResolved) throw new OrchError(`${st.id} is closed: its unsafe merge was settled (${st.unsafeResolved.checked}). Nothing to finish`, 2);
    throw new OrchError(`${st.id} was already merged, unsafely: ${st.parkReason}. Nothing to finish; after the owner's decision: orch resolve ${st.id} --checked "<what>"`, 2);
  }
  const record = (merge, already) => {
    st.phase = 'merged'; st.merge = merge; st.approvedBy ??= who; st.override = override ?? st.override;
    st.finishPending = ['tracker', 'cleanup'];
    event(st, 'merge', { sha: merge?.slice(0, 9), pr: st.pr.number, recovered: already || undefined });
    saveState(root, st);
    return completeFinish(root, cfg, st, tracker, notes);
  };
  const pr = prView(root, st.pr.number);
  if (!pr) throw new OrchError(`PR #${st.pr.number} not found`);
  if (pr.baseRefName !== st.baseBranch) {
    throw new OrchError(`PR #${pr.number} now targets ${pr.baseRefName}, not ${st.baseBranch}: someone changed it. Nothing was merged; set it back to ${st.baseBranch}, or park the task`);
  }
  if (pr.state === 'MERGED') {
    if (pr.headRefOid !== st.sha) throw new OrchError(`PR #${pr.number} was merged at ${pr.headRefOid.slice(0, 9)}, not at the checked ${st.sha.slice(0, 9)}: look at it on GitHub`);
    notes.push(`PR #${pr.number} was already merged at ${st.sha.slice(0, 9)} (an interrupted finish): recorded it`);
    return record(pr.mergeCommit?.oid, true);
  }
  if (pr.state !== 'OPEN') throw new OrchError(`PR #${pr.number} is ${pr.state.toLowerCase()}: nothing was pushed or merged`);
  if (!st.gate?.pass) throw new OrchError(`${st.id} has no passing gate: never merged`);
  if (st.phase !== 'ready' && !override) throw new OrchError(`${st.id} is in phase ${st.phase}, not ready: the checkers have not all passed (--override "<why>" only with the owner's ok)`);

  // A base merge an interruption left behind: in progress (abort it) or committed (adopt it, push it if needed).
  const mergeHead = path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], wt), 'MERGE_HEAD');
  if (fs.existsSync(mergeHead)) {
    const stuck = abortMerge(wt);
    if (stuck) throw new OrchError(`an interrupted finish left a base merge in progress in ${wt}.${stuck}`);
    notes.push('aborted a base merge left in progress by an interrupted finish');
  }
  if (st.baseMerge) {
    const head = git(['rev-parse', 'HEAD'], wt);
    const parents = git(['rev-list', '--parents', '-n', '1', head], wt).split(' ').slice(1);
    if (head !== st.sha && parents[0] === st.sha && parents[1] === st.baseMerge.base) {
      pushExact(wt, root, remote, st.branch, head, st.sha);
      notes.push(`adopted the base merge ${head.slice(0, 9)} of an interrupted finish (its checks had passed)`);
      Object.assign(st, { sha: head, mergedTree: git(['rev-parse', 'HEAD^{tree}'], wt), base: st.baseMerge.base });
      event(st, 'base-merged', { sha: head.slice(0, 9), recovered: true });
    }
    delete st.baseMerge; saveState(root, st);
  }

  if (stageAndTree(wt) !== expectedTree(st)) throw new OrchError('the worktree changed after the gate: run orch gate again');
  if (git(['rev-parse', 'HEAD'], wt) !== st.sha) throw new OrchError('the worktree has commits after the push: run orch gate, then orch push');
  const there = remoteSha(root, remote, st.branch);
  if (there !== st.sha) throw new OrchError(`the remote branch ${st.branch} is at ${there?.slice(0, 9) ?? '(missing)'}, not the checked ${st.sha.slice(0, 9)}: someone else pushed. Nothing was merged`);

  const task = tracker.get(st.id);
  let checkedMerged = false; // the "merge" harnesses ran on a base-merged tree in the loop below
  for (let i = 0; ; i++) {
    const baseNow = fetchBase(root, remote, st.baseBranch);
    if (git(['merge-base', '--is-ancestor', baseNow, st.sha], root, { allowFail: true }).code === 0) break;
    if (i === 3) throw new OrchError(`${st.baseBranch} moved 3 times during this finish: run orch finish ${st.id} again when it is quiet`);
    st.baseMerge = { base: baseNow }; saveState(root, st); // intent on record
    const m = git(['merge', '--no-ff', '--no-commit', baseNow], wt, { allowFail: true });
    if (m.code !== 0) {
      const stuck = abortMerge(wt);
      delete st.baseMerge; saveState(root, st);
      throw new OrchError(`${st.baseBranch} moved and does not merge cleanly into ${st.branch}: ${(m.err || m.out).split('\n')[0]}. Nothing was merged: park the task, or start a small card that resolves it.${stuck}`, 2);
    }
    const changed = git(['diff', '--no-renames', '--name-only', st.base, 'HEAD'], wt).split('\n').filter(Boolean);
    const inert = baseChangeInert(root, cfg, st.base, baseNow);
    const same = identicalToGate(root, cfg, st, task, wt);
    if (same.same) notes.push(`${st.baseBranch} moved only in inert files: checks and gate harnesses not repeated (merge.recheck if-changed)`);
    else if (inert) notes.push(`${st.baseBranch} moved only in ${inert}: the gate's harnesses were not repeated (project checks ran)`);
    checkedMerged = true;
    for (const x of mergeRuns(root, cfg, st, task, changed, !inert, wt, { lean: same.same })) {
      const r = x.run();
      writeAtomic(path.join(runDir(root, st.id), 'logs', x.log), `${x.label}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
      if (r.code !== 0) {
        const stuck = abortMerge(wt);
        delete st.baseMerge; event(st, 'merge-check', { pass: false, what: x.label }); saveState(root, st);
        if (r.infra) throw new OrchError(`${x.label} was stopped by the machine on the merged result (${r.infra}). Nothing was merged: run orch finish ${st.id} again.${stuck}`, 3);
        throw new OrchError(`${x.label} fails with ${st.baseBranch} merged in (exit ${r.code}): ${lastLines(r.out, 2).replace(/\n/g, ' | ')}. Nothing was merged.${stuck}`, 2);
      }
    }
    git(['commit', '-q', '--no-verify', '-m', `Merge ${st.baseBranch} into ${st.branch}`], wt);
    const sha = git(['rev-parse', 'HEAD'], wt);
    pushExact(wt, root, remote, st.branch, sha, st.sha);
    notes.push(`${st.baseBranch} had moved: merged it into ${st.branch}, checks passed, pushed ${sha.slice(0, 9)}`);
    Object.assign(st, { sha, mergedTree: git(['rev-parse', 'HEAD^{tree}'], wt), base: baseNow });
    delete st.baseMerge;
    event(st, 'base-merged', { sha: sha.slice(0, 9) }); saveState(root, st);
    postStatus(root, sha, 'orch/gate', 'success', same.same ? `${st.baseBranch} merged in (inert files only): identical checked tree` : `checks passed with ${st.baseBranch} merged in`);
  }
  // "merge" harnesses run on what GitHub will merge even when the base did not move (the branch already contains it).
  if (!checkedMerged) {
    const changed = git(['diff', '--no-renames', '--name-only', st.base, 'HEAD'], wt).split('\n').filter(Boolean);
    for (const x of mergeRuns(root, cfg, st, task, changed, false, wt, { lean: true })) {
      const r = x.run();
      writeAtomic(path.join(runDir(root, st.id), 'logs', x.log), `${x.label}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
      if (r.code !== 0) {
        event(st, 'merge-check', { pass: false, what: x.label }); saveState(root, st);
        if (r.infra) throw new OrchError(`${x.label} was stopped by the machine (${r.infra}). Nothing was merged: run orch finish ${st.id} again`, 3);
        throw new OrchError(`${x.label} fails on the branch to merge (exit ${r.code}): ${lastLines(r.out, 2).replace(/\n/g, ' | ')}. Nothing was merged`, 2);
      }
    }
    if (git(['status', '--porcelain', '--untracked-files=all'], wt).trim()) {
      throw new OrchError(`a "merge" harness left files in ${wt} (a report folder not ignored?): nothing was merged. Make the harness write outside the checkout or ignore its output, clean the worktree, then orch finish ${st.id} again`, 2);
    }
  }

  st.approvedBy = who; st.override = override ?? undefined;
  event(st, 'merging', { pr: st.pr.number, sha: st.sha.slice(0, 9) }); saveState(root, st); // intent on record
  let res;
  try {
    res = mergePr(root, st.pr.number, st.sha, {
      base: st.baseBranch,
      subject: `Merge ${st.branch}: ${st.id} ${st.title}`,
      body: `Approved by ${who}.${override ? ` Accepted without a checker PASS: ${override}` : ''}`,
    });
  } catch (e) {
    // GitHub confirmed that nothing was merged: the intent above is closed, so the run is not "mid-merge" any more.
    if (e.notMerged) { event(st, 'merge-failed', { pr: st.pr.number, why: e.message.slice(0, 200) }); saveState(root, st); }
    throw e;
  }
  // GitHub merged something else than asked (the PR was retargeted or its head changed at the last moment): the merge
  // cannot be undone, so it is not recorded as a normal one. The run stops here with the evidence, for the owner.
  if (res.mergedBase !== st.baseBranch || res.mergedHead !== st.sha) {
    st.phase = 'parked';
    st.merge = res.merge;
    st.parkReason = `UNSAFE MERGE: PR #${st.pr.number} was merged into ${res.mergedBase} at ${res.mergedHead?.slice(0, 9)}, not into ${st.baseBranch} at the checked ${st.sha.slice(0, 9)}. Check ${res.mergedBase} and decide with the owner (revert?)`;
    st.unsafeMerge = { base: res.mergedBase, head: res.mergedHead, merge: res.merge };
    event(st, 'unsafe-merge', { base: res.mergedBase, head: res.mergedHead?.slice(0, 9), merge: res.merge?.slice(0, 9) });
    saveState(root, st);
    try { tracker.setStatus(st.id, cfg.tracker.status.blocked); tracker.comment(st.id, st.parkReason); } catch { /* the state holds it */ }
    throw new OrchError(st.parkReason, 2);
  }
  // The base can move between the last fetch and GitHub's merge: then the merged tree is a combination nobody checked.
  if (res.merge) {
    git(['fetch', '-q', remote, `+refs/heads/${st.baseBranch}:refs/remotes/${remote}/${st.baseBranch}`], root, { allowFail: true });
    const mergedTree = git(['rev-parse', `${res.merge}^{tree}`], root, { allowFail: true }).out;
    if (mergedTree && mergedTree !== git(['rev-parse', `${st.sha}^{tree}`], root)) {
      st.untestedMerge = true;
      notes.push(`ATTENTION: ${st.baseBranch} moved while the PR was being merged: the merged result ${res.merge.slice(0, 9)} is not the checked tree. Run the checks on ${st.baseBranch} now and tell the owner`);
    }
  }
  return record(res.merge, res.already);
}

// The owner's (or coordinator's) record that the unchecked merged result was checked after all, or accepted.
async function cmdResolve(root, { pos, flags }) {
  const st = loadState(root, need(pos[0], 'task id'));
  const checked = typeof flags.checked === 'string' ? flags.checked.trim() : '';
  if (!blocking(st)) throw new OrchError(`${st.id} has nothing to resolve`);
  if (!checked) throw new OrchError('orch resolve <id> --checked "<the commands that passed on the merged result, or the owner\'s decision>"');
  if (unresolvedUntested(st)) st.untestedResolved = { checked, at: now() };
  if (unresolvedUnsafe(st)) st.unsafeResolved = { checked, at: now() };
  event(st, 'merge-resolved', { checked }); saveState(root, st);
  out(`${st.id}: the merge is recorded as settled (${checked})`, 'next: orch next');
}

// Did the base move only in files that cannot change a build or a test result: the in-repo tracker, .orchestrate/
// (but not its config.json) and the project's merge.inertPaths? Returns a short description of them, or '' when anything else changed (then the
// merge repeats the gate's harnesses). Nothing is inert by assumption, not even documentation.
function baseChangeInert(root, cfg, from, to) {
  const inertGlobs = [...(cfg.tracker.dir ? [`${cfg.tracker.dir}/**`] : []), '.orchestrate/**', ...(cfg.merge.inertPaths ?? [])];
  const r = git(['diff', '--no-renames', '--name-only', from, to], root, { allowFail: true });
  if (r.code !== 0) return '';
  const files = r.out.split('\n').filter(Boolean);
  // The orch config defines checks and harnesses: a change to it is a change to the tests, never inert.
  if (!files.length || !files.every(f => matchesAny(inertGlobs, f) && f !== '.orchestrate/config.json')) return '';
  return `${files.length} file(s) under ${[...new Set(files.map(f => inertGlobs.find(g => matchesAny([g], f))))].join(', ')}`;
}

// The checks on a merged tree in `cwd`, before its merge commit exists. Harnesses: the "merge" ones, and the "gate" ones
// too when the base branch moved since the start (the merged tree is then not the gated tree), in the mode the gate
// used (its fast specs, or the whole suite).
// git merge --abort, saying so when it could not abort (a lock file, a file locally modified on top of the merge):
// never claim an abort that did not happen.
function abortMerge(cwd) {
  // A merge git refused before starting (an untracked file in the way) left nothing to abort.
  if (!fs.existsSync(path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd), 'MERGE_HEAD'))) return '';
  const r = git(['merge', '--abort'], cwd, { allowFail: true });
  return r.code === 0 ? '' : ` The merge could NOT be aborted (${(r.err || r.out).split('\n')[0]}): look at git status in ${cwd} before anything else.`;
}

// merge.recheck "if-changed": the merged index differs from the gated tree only in inert paths (tracker, .orchestrate
// except its config, merge.inertPaths) and the checks and harnesses are those of the gate. The same bytes give the
// same verdict, so the checks and the gate harnesses are not repeated; "merge" harnesses always run.
function identicalToGate(root, cfg, st, task, cwd) {
  if (cfg.merge.recheck !== 'if-changed' || !st.gate?.tree || !st.gate.cfgHash || st.gate.cfgHash !== checksHash(cfg, task)) return { same: false, tree: git(['write-tree'], cwd) };
  const tree = git(['write-tree'], cwd);
  const files = git(['diff', '--no-renames', '--name-only', st.gate.tree, tree], cwd).split('\n').filter(Boolean);
  const inertGlobs = [...(cfg.tracker.dir ? [`${cfg.tracker.dir}/**`] : []), '.orchestrate/**', ...(cfg.merge.inertPaths ?? [])];
  return { same: files.every(f => matchesAny(inertGlobs, f) && f !== '.orchestrate/config.json'), tree, files };
}

function mergeRuns(root, cfg, st, task, changed, moved, cwd, { lean = false } = {}) {
  if (lean) return harnessesFor(cfg, task, changed, 'merge').map(h => ({ label: `harness ${h.name}`, log: `merge-harness-${h.name}.log`, run: () => runHarness(root, h, cwd) }));
  return [
    ...checksFor(cfg, task).map((cmd, i) => ({ label: `check "${cmd}"`, log: `merge-check-${i + 1}.log`, run: () => sh(cmd, { cwd, timeoutSec: cfg.limits.checkTimeoutSec }) })),
    ...harnessesFor(cfg, task, changed, 'merge')
      .map(h => ({ label: `harness ${h.name}`, log: `merge-harness-${h.name}.log`, run: () => runHarness(root, h, cwd) })),
    ...(moved ? (st.gate.harnessRuns ?? harnessesFor(cfg, task, changed, 'gate').map(h => ({ name: h.name, mode: 'full', specs: [] }))) : [])
      .filter(x => x.mode !== 'skip')
      .map(x => ({ x, h: cfg.harnesses.find(h => h.name === x.name) }))
      .filter(({ h }) => h)
      .map(({ x, h }) => {
        const command = x.mode === 'fast' ? `${h.command} ${x.specs.map(shq).join(' ')}` : h.command;
        return { label: `harness ${h.name} (${x.mode})`, log: `merge-harness-${h.name}.log`, run: () => runHarness(root, { ...h, command }, cwd) };
      }),
  ];
}

// The steps after the merge commit, each recorded when done, so a rerun of finish only does what is missing.
function completeFinish(root, cfg, st, tracker, notes) {
  const warnings = [...notes];
  const pending = new Set(st.finishPending ?? []);
  if (pending.has('cleanup')) {
    for (const l of st.links ?? []) { try { fs.unlinkSync(path.join(st.worktree, l)); } catch { /* already gone */ } }
    if (fs.existsSync(st.worktree)) {
      const rm = git(['worktree', 'remove', st.worktree], root, { allowFail: true });
      if (rm.code !== 0) warnings.push(`worktree kept: ${rm.err.split('\n')[0]}`);
    }
    // A PR's branch is merged on GitHub, not into the local base: -D is safe once the PR is merged.
    if (!fs.existsSync(st.worktree) && git(['rev-parse', '--verify', '--quiet', `refs/heads/${st.branch}`], root, { allowFail: true }).code === 0
      && git(['branch', st.delivery === 'pr' ? '-D' : '-d', st.branch], root, { allowFail: true }).code !== 0) warnings.push(`branch ${st.branch} kept`);
    if (st.delivery === 'pr') {
      const remote = cfg.delivery.remote;
      // Deleted only while it is still the commit orch pushed, with a lease against a push in between: commits
      // someone else added after the merge keep their branch.
      const tip = remoteSha(root, remote, st.branch);
      if (tip && tip !== st.sha) warnings.push(`remote branch ${st.branch} kept: it is at ${tip.slice(0, 9)}, not the merged ${st.sha.slice(0, 9)} (someone pushed after the merge)`);
      else if (tip && git(['push', '-q', `--force-with-lease=refs/heads/${st.branch}:${st.sha}`, remote, '--delete', st.branch], root, { allowFail: true }).code !== 0) {
        warnings.push(`remote branch ${st.branch} kept: it changed while being deleted`);
      }
      fetchBase(root, remote, st.baseBranch);
      const here = git(['branch', '--show-current'], root);
      if (here === st.baseBranch && git(['merge', '-q', '--ff-only', `${remote}/${st.baseBranch}`], root, { allowFail: true }).code !== 0) warnings.push(`local ${st.baseBranch} not fast-forwarded to ${remote}/${st.baseBranch}: update it by hand`);
    }
    const swept = cleanRun(root, cfg, st.id, { merged: true });
    if (swept.deleted) warnings.push(`artifacts: ${swept.deleted} scope(s) of ${st.id} deleted, ${gb(swept.freed)} freed`);
    pending.delete('cleanup');
    st.finishPending = [...pending]; st.metrics = metrics(st); saveState(root, st);
  }
  if (pending.has('tracker')) {
    try {
      tracker.setStatus(st.id, cfg.tracker.status.done);
      tracker.comment(st.id, `merged into ${st.baseBranch} as ${st.merge.slice(0, 9)}${st.pr ? ` (PR ${st.pr.url})` : ''}, approved by ${st.approvedBy}${st.override ? ' (checker override)' : ''}; ${st.metrics.rounds} correction round(s), ${st.metrics.elapsed}`);
      pending.delete('tracker');
    } catch (e) {
      warnings.push(`the tracker was not updated (${e.message}): run orch finish ${st.id} again to retry`);
    }
    st.finishPending = [...pending]; saveState(root, st);
  }
  out(`merged ${st.id} into ${st.baseBranch}: ${st.merge.slice(0, 9)}${pending.has('tracker') ? '' : ` · status ${cfg.tracker.status.done}`}`, ...warnings.map(w => `warning: ${w}`),
    `metrics: ${JSON.stringify(st.metrics)}`, `next: ${pending.size ? `orch finish ${st.id} (to finish: ${[...pending].join(', ')})` : 'orch next'}`);
}

// This card's merge commit on `ref`, or null: a merge with `head` (the branch tip) as a later parent, made by orch
// for this card (its own subject, "Merge <branch>: <id> …", whatever a commit hook did to the tree) or, for a merge
// written otherwise, one whose tip has the gated tree. A tip that the base merely contains (the worker fast-forwarded
// its branch onto the base or onto another card) is not a merge of this card.
function mergeOf(root, st, head, ref) {
  const lines = git(['log', '--merges', '--ancestry-path', '--format=%H %P%x09%s', `${head}..${ref}`], root, { allowFail: true }).out.split('\n').filter(Boolean);
  const tipTree = git(['rev-parse', '--verify', '--quiet', `${head}^{tree}`], root, { allowFail: true }).out.trim();
  const gated = !st.gate?.tree || tipTree === st.gate.tree;
  const hit = lines.reverse().find(l => {
    const [ids, subject = ''] = l.split('\t');
    return ids.split(' ').slice(2).includes(head) && (subject.startsWith(`Merge ${st.branch}: ${st.id} `) || gated);
  });
  return hit ? hit.split(' ')[0] : null;
}

// A finish killed mid-way leaves one of two traces in the main checkout: a merge in progress of this task's branch
// (MERGE_HEAD = the branch: the checks were running, nothing was committed) — abort it and start over; or the merge
// commit already on the base branch with the state not saved — record it and go on with the steps after it.
function recoverInterruptedMerge(root, st) {
  const notes = [];
  const head = git(['rev-parse', '--verify', '--quiet', `refs/heads/${st.branch}`], root, { allowFail: true }).out;
  if (!head) return { merged: false, notes };
  const mergeHead = path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], root), 'MERGE_HEAD');
  if (fs.existsSync(mergeHead) && fs.readFileSync(mergeHead, 'utf8').trim() === head) {
    const stuck = abortMerge(root);
    if (stuck) throw new OrchError(`an interrupted finish left a merge of ${st.branch} in progress.${stuck}`);
    event(st, 'merge-recovered', { what: 'aborted an interrupted merge' }); saveState(root, st);
    notes.push('aborted a merge left in progress by an interrupted finish');
    return { merged: false, notes };
  }
  const commit = head !== st.base ? mergeOf(root, st, head, st.baseBranch) : null;
  if (commit) {
    const msg = git(['log', '-1', '--format=%B', commit], root);
    st.phase = 'merged'; st.merge = commit;
    st.approvedBy = (msg.match(/Approved by (.+?)\.(?:\s|$)/) ?? [])[1] ?? 'unknown (recovered)';
    st.finishPending = ['tracker', 'cleanup'];
    // Killed between the merge commit and its tree check: compare with what was recorded before the commit.
    if (st.mergeIntent?.tree && git(['rev-parse', `${commit}^{tree}`], root) !== st.mergeIntent.tree) {
      st.untestedMerge = true;
      notes.push(`a commit hook changed the merge ${commit.slice(0, 9)}: the merged files are not the checked ones; run the checks on ${st.baseBranch}, then orch resolve ${st.id} --checked "<what passed>"`);
    }
    event(st, 'merge', { sha: commit.slice(0, 9), recovered: true }); saveState(root, st);
    notes.push(`the merge ${commit.slice(0, 9)} was already on ${st.baseBranch} (an interrupted finish): recorded it`);
    return { merged: true, notes };
  }
  return { merged: false, notes };
}

async function cmdPark(root, { pos, flags }) {
  const id = need(pos[0], 'task id');
  const reason = flags.reason;
  if (!reason || reason === true) throw new OrchError('park needs --reason "<why>"');
  const cfg = loadConfig(root);
  const st = activeState(root, id);
  if (st.phase === 'merged') throw new OrchError(`${st.id} is merged`);
  if (st.unsafeMerge) throw new OrchError(`${st.id} is parked as an unsafe merge; that reason stays (orch resolve after the owner's decision)`);
  st.phase = 'parked'; st.parkReason = reason;
  event(st, 'park', { reason });
  saveState(root, st);
  const tracker = await trackerFor(root, cfg);
  tracker.setStatus(st.id, cfg.tracker.status.blocked);
  tracker.comment(st.id, `parked: ${reason} (worktree kept: ${st.worktree})`);
  out(`parked ${st.id}; worktree kept at ${st.worktree}`, 'next: tell the owner; orch next');
}

async function cmdStatus(root, { pos, flags }) {
  const cfg = loadConfig(root, { requireConfirmed: false });
  const runs = path.join(orchDir(root), 'runs');
  const ids = pos[0] ? [pos[0].toUpperCase()] : fs.existsSync(runs) ? fs.readdirSync(runs).filter(d => fs.existsSync(path.join(runs, d, 'state.json'))) : [];
  const states = ids.map(i => loadState(root, i)).filter(s => pos[0] || flags.all || s.phase !== 'merged' || s.finishPending?.length || unresolvedUntested(s));
  if (flags.json) { console.log(JSON.stringify(states.map(s => ({ id: s.id, phase: s.phase, round: s.round, gate: s.gate, verdicts: s.verdicts, untestedMerge: unresolvedUntested(s) || undefined, unsafeMerge: unresolvedUnsafe(s) ? s.unsafeMerge : undefined, next: nextAction(s, cfg), metrics: metrics(s) })), null, 2)); return; }
  out(states.length ? states.map(s => statusLine(s, cfg)).join('\n\n') : `no open run${cfg.confirmed ? '' : ' (config not confirmed)'}\nnext: orch next`);
}

async function cmdPrompt(root, { pos }) {
  const st = loadState(root, need(pos[0], 'task id'));
  const role = need(pos[1], 'worker|checker|advisor');
  if (role === 'advisor') {
    // The brief for the sub-agent that advises the coordinator on a run at its round limit (split or park).
    const cfg = loadConfig(root);
    const atLimit = ['rejected', 'gate-failed'].includes(st.phase) && st.round >= cfg.limits.correctionRounds;
    if (!atLimit) throw new OrchError(`${st.id} is not at its round limit (${st.phase}, round ${st.round}/${cfg.limits.correctionRounds}): no advisor needed`);
    const task = (await trackerFor(root, cfg)).get(st.id);
    const file = path.join(runDir(root, st.id), 'prompts', `advisor-r${st.round}.md`);
    writeAtomic(file, fill(tpl('advisor'), {
      id: st.id, title: st.title, round: st.round, maxRounds: cfg.limits.correctionRounds, worktree: st.worktree, base: st.base,
      runDir: runDir(root, st.id), description: task.description || '(no description)', acceptance: task.acceptance || '(none)',
      owned: block(task.ownedFiles), reportPath: path.join(runDir(root, st.id), 'inbox', `advisor-r${st.round}.md`),
    }));
    out(file, `next: delegate it to one sub-agent (label "${st.id} advisor r${st.round}", task "Read ${file} and do what it says."), wait for its report, then decide: split or park`);
    return;
  }
  out(role === 'worker' ? st.prompt : st.checkerPrompts.map(p => `${p.tag}: ${p.prompt}`).join('\n') || 'no checker prompt yet (it comes with a gate PASS)');
}

// A harness on demand: once on the base branch at setup (a harness that fails there would fail every gate), or in a
// task's worktree to see a failure again. Uses the same lock as the gate.
async function cmdHarness(root, { pos, flags }) {
  const cfg = loadConfig(root, { requireConfirmed: false });
  const name = need(pos[0], `harness name (${cfg.harnesses.map(h => h.name).join(', ') || 'none configured'})`);
  const h = cfg.harnesses.find(x => x.name === name);
  if (!h) throw new OrchError(`no harness "${name}" in the config (${cfg.harnesses.map(x => x.name).join(', ') || 'none'})`);
  const cwd = flags.in ? loadState(root, flags.in).worktree : root;
  const r = runHarness(root, h, cwd);
  const log = path.join(orchDir(root), 'runs', flags.in ? String(flags.in).toUpperCase() : '_harness', 'logs', `harness-${name}-${now().replace(/[:]/g, '')}.log`);
  writeAtomic(log, `$ ${h.command}\nexit ${r.code}${r.timedOut ? ' (timeout)' : ''} in ${minutes(r.ms)}\n\n${r.out}`);
  out(`harness ${name} in ${cwd}: ${r.code === 0 ? 'PASS' : `FAIL (exit ${r.code}${r.timedOut ? ', timeout' : ''})`} in ${minutes(r.ms)}`,
    r.code === 0 ? null : lastLines(r.out, 6), `log: ${log}`,
    `next: ${r.code === 0 ? 'orch config --confirm (after the owner\'s ok)' : 'tell the owner: fix the harness (or its command, env, port) before any task depends on it'}`);
  process.exitCode = r.code === 0 ? 0 : 2;
}

// ---------------------------------------------------------------------------------------------------- campaign keeper

const campaignFile = root => path.join(orchDir(root), 'campaign.json');
const readCampaign = root => readJson(campaignFile(root), null);
const activityFile = root => path.join(orchDir(root), 'activity');

// One lock for every change to campaign.json (keeper, start, stop), so a stop is never overwritten by a keeper that
// read the campaign just before it. A lock left by a dead process, or older than two minutes, is taken over.
function withCampaignLock(root, fn, { waitMs = 10_000 } = {}) {
  const lock = path.join(orchDir(root), 'campaign.lock');
  const t0 = Date.now();
  const token = `${process.pid} ${Date.now()} ${Math.random()}`;
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), token); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let stale = false; let judged = null;
    try {
      judged = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
      const pid = Number(judged.split(' ')[0]);
      try { process.kill(pid, 0); } catch (e) { stale = e.code === 'ESRCH'; }
      if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) stale = true;
    } catch { stale = fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 5_000; } // no owner yet: give it 5 s
    // A takeover renames the stale lock away first: only one waiter wins the rename, the others try again.
    if (Date.now() - t0 > waitMs) return { locked: true };
    if (stale) {
      // Only one waiter wins the rename. If what it renamed is no longer the stale lock it judged (another waiter took
      // over and locked in between), it puts it back.
      const away = `${lock}.stale-${process.pid}`;
      try {
        fs.renameSync(lock, away);
        const got = (() => { try { return fs.readFileSync(path.join(away, 'owner'), 'utf8'); } catch { return null; } })();
        if (got !== judged) fs.renameSync(away, lock); else fs.rmSync(away, { recursive: true, force: true });
      } catch { /* another waiter took it */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try { return { value: fn() }; } finally {
    try { if (fs.readFileSync(path.join(lock, 'owner'), 'utf8') === token) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* taken over */ }
  }
}

// `orch campaign start --session <key> [--scope all|ID,ID] [--by <owner>] [--idle-minutes n]`: the owner's mandate to
// work a set of cards to the end, and the one coordinator session the keeper may wake. `stop`, `status`, `job-script`.
async function cmdCampaign(root, { pos, flags }) {
  const sub = pos[0];
  const cfg = loadConfig(root);
  if (sub === 'start') {
    const session = typeof flags.session === 'string' ? flags.session.trim() : '';
    if (!session) throw new OrchError('orch campaign start --session <the coordinator session key> [--scope all|ID,ID] [--by <owner>]');
    if (flags.scope === true || flags.scope === '') throw new OrchError('--scope needs a value: all, or a comma list of card ids');
    const scope = flags.scope === undefined || flags.scope === 'all' ? 'all' : String(flags.scope).split(',').map(s => s.trim()).filter(Boolean);
    if (scope !== 'all' && !scope.length) throw new OrchError('--scope names no card: all, or a comma list of card ids');
    if (scope !== 'all') {
      const known = new Set((await trackerFor(root, cfg)).list().map(t => t.id.toUpperCase()));
      const unknown = scope.filter(id => !known.has(id.toUpperCase()));
      if (unknown.length) throw new OrchError(`--scope names card(s) the tracker does not have: ${unknown.join(', ')}`);
    }
    let idle = CAMPAIGN_DEFAULTS.idleMinutes;
    if (flags['idle-minutes'] !== undefined) {
      idle = Number(flags['idle-minutes']);
      if (!Number.isFinite(idle) || idle < 1) throw new OrchError('--idle-minutes must be a number of minutes, at least 1');
    }
    const r = withCampaignLock(root, () => {
      const current = readCampaign(root);
      if (current?.active && !flags.force) throw new OrchError(`a campaign is active since ${current.startedAt} (orch campaign status; stop it first, or --force)`);
      writeJson(campaignFile(root), {
        ...CAMPAIGN_DEFAULTS, idleMinutes: idle, active: true, scope, scopeLabel: scope === 'all' ? 'every To Do card' : scope.join(', '), session,
        by: typeof flags.by === 'string' ? flags.by : null, startedAt: new Date().toISOString(), wakes: { count: 0, at: 0, progress: null }, reported: {},
      });
    });
    if (r.locked) throw new OrchError('the campaign is being changed by another orch command: try again');
    out(`campaign started: ${scope === 'all' ? 'every To Do card' : scope.join(', ')} · coordinator ${session}`, 'next: install the keeper job (orch campaign job-script), then orch next');
    return;
  }
  if (sub === 'stop') {
    const r = withCampaignLock(root, () => {
      const current = readCampaign(root);
      if (!current?.active) throw new OrchError('no active campaign');
      writeJson(campaignFile(root), { ...current, active: false, stoppedAt: now(), stopReason: typeof flags.reason === 'string' ? flags.reason : 'stopped by orch campaign stop' });
    });
    if (r.locked) throw new OrchError('the campaign is being changed by another orch command: try again');
    out('campaign stopped: the keeper wakes nobody until a new orch campaign start');
    return;
  }
  if (sub === 'status') {
    const current = readCampaign(root);
    const d = await keeperDecision(root, cfg, current);
    if (flags.json) { console.log(JSON.stringify({ campaign: current, decision: d }, null, 2)); return; }
    out(current ? `campaign ${current.active ? 'active' : 'stopped'}: ${current.scopeLabel} · coordinator ${current.session} · since ${current.startedAt}` : 'no campaign',
      `keeper would: ${d.action} (${d.reason})`);
    return;
  }
  if (sub === 'job-script') {
    // The OpenClaw automation that runs the keeper: a headless script (no model turn) that wakes the coordinator with
    // sessions_send only when the keeper says so and sends the owner's notices to the same conversation (the owner
    // reads it, on the web or a chat channel); the script's own result carries them only when that send fails, and an
    // unreadable keeper output once (not every run).
    const cmd = `cd ${shq(root)} && node ${shq(path.join(SKILL, 'scripts', 'orch.mjs'))} keeper --json`;
    console.log([
      `// orch campaign keeper for ${root} (generated by orch campaign job-script). Install as an OpenClaw script job,`,
      `// for example: openclaw cron add --agent <agent> --name orch-keeper --every 5m --script <this file> --session main`,
      `const r = await exec({ command: ${JSON.stringify(cmd)} });`,
      `const lines = String(r?.aggregated ?? '').trim().split('\\n');`,
      'let k;',
      'try { k = JSON.parse(lines[lines.length - 1]); if (!k || typeof k !== "object") throw new Error(); } catch {',
      '  const error = `orch keeper: unreadable output: ${lines.slice(-3).join(" | ").slice(0, 300)}`;',
      "  const prev = typeof trigger === 'undefined' ? undefined : trigger?.state;",
      '  return prev?.error === error ? { state: prev } : { notify: error, state: { error } };',
      '}',
      '// The owner reads the coordinator\'s conversation (dashboard or chat channel): notices go there too.',
      "const forOwner = k.notify ? `${k.notify} This is for the owner: tell them in one line in this conversation (if you already told them, say nothing new); when it needs their decision, wait for it and do not act on it yourself.` : null;",
      "const text = k.action === 'wake' ? [k.message, forOwner].filter(Boolean).join('\\n\\n') : forOwner;",
      'const notes = [];',
      'if (text && k.session) {',
      '  try {',
      '    // A send that cannot be delivered may resolve with a status instead of throwing: only these mean it went in.',
      '    const res = await sessions_send({ sessionKey: k.session, message: text, timeoutSeconds: 0 });',
      '    const p = res?.details ?? res; // the payload, also when the runtime hands back the raw tool result',
      "    if (p?.error || (p?.status && !['accepted', 'queued', 'ok', 'no_reply', 'timeout'].includes(p.status))) throw new Error(p.error ?? `not delivered (${p.status})`);",
      '  }',
      `  catch (e) { notes.push(...(k.notify ? [k.notify] : []), \`[orch keeper] could not reach the coordinator \${k.session}: \${String(e?.message ?? e).slice(0, 200)}\`); }`,
      '} else if (k.notify) notes.push(k.notify);',
      "return { ...(notes.length ? { notify: notes.join('\\n') } : {}), state: { last: k.action, at: Date.now() } };",
    ].join('\n'));
    return;
  }
  throw new OrchError('orch campaign start|stop|status|job-script');
}

// What is running right now in this project: a live harness lock, or (Linux) an orch command, managed check or run-cmd
// whose working directory is this project or one of its worktrees. The keeper's own commands do not count.
function busyNow(root, cfg) {
  const lock = path.join(orchDir(root), 'harness.lock', 'pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { if (pid) { process.kill(pid, 0); return `a harness (pid ${pid})`; } } catch { /* stale lock */ }
  }
  if (!fs.existsSync('/proc')) return null; // not Linux: no process scan
  const mine = [fs.realpathSync(root), path.resolve(root, cfg.worktreeRoot)];
  for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x) && Number(x) !== process.pid && Number(x) !== process.ppid)) {
    let argv; let cwd;
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    const i = argv.findIndex(a => /\/(?:orch|managed-check|run-cmd)\.mjs$/.test(a));
    if (i < 0 || ['keeper', 'campaign'].includes(argv[i + 1])) continue;
    if (!mine.some(d => cwd === d || cwd.startsWith(`${d}/`))) continue; // another project's command
    return `${argv.slice(i, i + 3).map(a => path.basename(a)).join(' ')} (pid ${pid})`;
  }
  return null;
}

// Latest sign of the coordinator's work: any orch command (the activity file), a run's state, a card file of an
// in-repo tracker, or the campaign start.
function lastActivity(root, cfg, campaign, stateMtimes) {
  const times = [Date.parse(campaign.startedAt) || 0, ...stateMtimes];
  try { times.push(fs.statSync(activityFile(root)).mtimeMs); } catch { /* none yet */ }
  if (cfg.tracker.dir) {
    const dir = path.join(root, cfg.tracker.dir, 'tasks');
    try { for (const f of fs.readdirSync(dir)) times.push(fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* no folder */ }
  }
  return Math.max(...times);
}

// Reports a sub-agent left in a run's inbox that orch record has not taken yet (record moves them to reports/).
function inboxReports(root, st) {
  const dir = path.join(runDir(root, st.id), 'inbox');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const tags = new Set((st.checkerPrompts ?? []).map(p => p.tag));
  const opened = phaseOpenedAt(st);
  const at = f => fs.statSync(path.join(dir, f)).mtimeMs;
  if (st.phase === 'working') return names.includes('worker.md') && at('worker.md') >= opened - 1000 ? [{ tag: null, mtime: at('worker.md') }] : [];
  // This round's name; the older releases' name only when written after this round's gate (1 s: file time granularity).
  return [...tags].flatMap(tag => {
    const f = [`checker-r${st.round}-${tag}.md`, `checker-${tag}.md`].find(n => names.includes(n)
      && (n === `checker-r${st.round}-${tag}.md` || (at(n) >= opened - 1000 && legacyCheckerName(root, st, tag))));
    return f ? [{ tag, mtime: at(f) }] : [];
  });
}

// The runtime's sessions, to see whether a sub-agent a run waits for is running: `openclaw sessions --json` when the
// openclaw CLI is there (ORCH_SESSIONS_JSON: a file with that output, for tests). null when unknown, and when the
// list does not hold the campaign's coordinator session (another runtime than the one running this project): the
// keeper then only relies on time limits and inbox reports, as without a runtime.
function liveSessions(coordinator) {
  try {
    const text = process.env.ORCH_SESSIONS_JSON ? fs.readFileSync(process.env.ORCH_SESSIONS_JSON, 'utf8')
      : (() => { const r = spawnSync('openclaw', ['sessions', '--active', '1440', '--limit', 'all', '--json'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : ''; })();
    const json = JSON.parse(text.slice(text.indexOf('{')));
    const rows = Array.isArray(json) ? json : json.sessions;
    if (!Array.isArray(rows) || !rows.some(s => s?.key === coordinator)) return null;
    return rows.filter(s => typeof s?.label === 'string').map(s => ({ label: s.label, status: s.status, endedAt: s.endedAt ?? null, updatedAt: Number(s.updatedAt) || 0 }));
  } catch { return null; }
}

// The sub-agents each working or checking run waits for: its worker, or the checkers of this round not recorded yet.
function expectedSubAgents(st) {
  if (st.phase === 'working') return { opened: phaseOpenedAt(st), labels: [{ label: `${st.id} worker r${st.round}`, who: 'worker' }] };
  const done = new Set(currentVerdicts(st).map(v => v.tag));
  return { opened: phaseOpenedAt(st), labels: (st.checkerPrompts ?? []).filter(p => !done.has(p.tag)).map(p => ({ label: `${st.id} checker ${p.tag} r${st.round}`, who: 'checker', tag: p.tag })) };
}

async function keeperDecision(root, cfg, campaign) {
  if (!campaign?.active) return decide({ campaign });
  if (campaign.scope !== 'all' && !(Array.isArray(campaign.scope) && campaign.scope.every(x => typeof x === 'string'))) return { action: 'off', reason: 'campaign.json has no scope: orch campaign start again', escalations: [] };
  const runsDir = path.join(orchDir(root), 'runs');
  const all = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(d => fs.existsSync(path.join(runsDir, d, 'state.json'))) : [];
  const states = all.map(d => ({ st: loadState(root, d), mtime: fs.statSync(path.join(runsDir, d, 'state.json')).mtimeMs }));
  const tracker = await trackerFor(root, cfg);
  const tasks = tracker.list();
  const S = cfg.tracker.status;
  // A card is in scope when it, or a card it was split from, is named: a split keeps the campaign on its children.
  const parentOf = new Map(tasks.filter(t => t.parent).map(t => [t.id.toUpperCase(), t.parent.toUpperCase()]));
  const named = campaign.scope === 'all' ? null : new Set(campaign.scope.map(x => x.toUpperCase()));
  const inScope = id => {
    if (!named) return true;
    for (let k = id.toUpperCase(), hops = 0; k && hops < 20; k = parentOf.get(k), hops++) if (named.has(k)) return true;
    return false;
  };
  const evals = evaluate(tasks, cfg, trackedFiles(root)).filter(r => inScope(r.task.id));
  const open = states.map(s => s.st)
    .filter(st => inScope(st.id) && (!['merged', 'parked'].includes(st.phase) || (st.phase === 'merged' && st.finishPending?.length)));
  const openIds = new Set(open.map(st => st.id.toUpperCase()));
  const doneInScope = tasks.filter(t => inScope(t.id) && t.status === S.done).length;
  const remaining = tasks.filter(t => inScope(t.id) && [S.todo, S.inProgress, S.inCheck, S.blocked].includes(t.status));
  const waiting = evals.filter(r => r.reasons.length).map(r => ({ id: r.task.id, reasons: r.reasons }));
  for (const t of remaining.filter(t => t.status !== S.todo && !openIds.has(t.id.toUpperCase()))) {
    waiting.push({ id: t.id, reasons: [t.status === S.blocked ? 'blocked (parked)' : `${t.status} without an open run`] });
  }
  const now_ = Number(process.env.ORCH_NOW) || Date.now();
  const busy = busyNow(root, cfg);
  const activity = lastActivity(root, cfg, campaign, states.map(s => s.mtime));
  return decide({
    now: now_, campaign, runs: open, lastActivity: activity,
    busy, busySince: busy && campaign.busy?.what === busy ? campaign.busy.since : null,
    othersRunning: states.some(({ st }) => !inScope(st.id) && ['working', 'checking'].includes(st.phase)
      && now_ - (Date.parse(st.events.at(-1)?.t ?? 0) || 0) < (st.phase === 'working' ? cfg.limits.workerTimeoutSec : cfg.limits.checkerTimeoutSec) * 1000),
    blocked: untestedRuns(root).map(s => ({ id: s.id, why: unresolvedUnsafe(s) ? 'unsafe merge' : 'merged result never checked' })),
    eligible: evals.filter(r => !r.reasons.length).map(r => ({ id: r.task.id })), waiting, remaining,
    standing: Boolean(standingApproval(cfg)), limits: cfg.limits, selfDecides: selfDecides(cfg),
    advisorBriefAt: Object.fromEntries(open.map(st => { try { return [st.id, fs.statSync(path.join(runDir(root, st.id), 'prompts', `advisor-r${st.round}.md`)).mtimeMs]; } catch { return [st.id, 0]; } })), nextFor: st => nextAction(st, cfg),
    progress: `${Math.max(0, ...states.filter(s => inScope(s.st.id)).map(s => s.mtime))}|${doneInScope}`,
    reports: Object.fromEntries(open.filter(st => ['working', 'checking'].includes(st.phase)).map(st => [st.id, inboxReports(root, st)])),
    ...(() => {
      const waiting = open.filter(st => ['working', 'checking'].includes(st.phase));
      // Runs at their round limit decided by the coordinator: their advisor sub-agent may be at work.
      const advised = selfDecides(cfg) && open.some(st => ['rejected', 'gate-failed'].includes(st.phase) && st.round >= cfg.limits.correctionRounds);
      if ((!waiting.length && !advised) || busy) return { sessions: null };
      // The CLI takes seconds: only asked when the rule can fire (coordinator quiet, a phase open for idleMinutes).
      const idle = (campaign.idleMinutes ?? CAMPAIGN_DEFAULTS.idleMinutes) * 60000;
      const expected = Object.fromEntries(waiting.map(st => [st.id, expectedSubAgents(st)]));
      const can = now_ - activity >= idle && (advised || Object.values(expected).some(e => e.labels.length && now_ - e.opened >= idle));
      return can ? { sessions: liveSessions(campaign.session), expected } : { sessions: null };
    })(),
  });
}

// `orch keeper [--json]`: the decision for the automation. Under the campaign lock it re-reads the campaign before
// writing: a campaign stopped or restarted during the check is left alone and nobody is woken. It records wakes (for
// the backoff) and the escalations already reported (each key once, again only after it went away), and ends the
// campaign when it is done.
async function cmdKeeper(root, { flags }) {
  const print = d => { if (flags.json) console.log(JSON.stringify(d)); else out(`keeper: ${d.action} (${d.reason})`, d.message ? `message: ${d.message}` : null, d.notify ? `owner: ${d.notify}` : null); };
  const cfg = loadConfig(root, { requireConfirmed: false });
  if (!cfg.confirmed) return print({ action: 'off', reason: 'the orch config is not confirmed' });
  const before = readCampaign(root);
  const d = await keeperDecision(root, cfg, before);
  if (!before?.active) return print(d);
  // The owner is told once when free disk falls below twice the reserve the checks need.
  if (cfg.artifacts.enabled && cfg.artifacts.minFreeBytes > 0) {
    try {
      const s = fs.statfsSync(path.dirname(artifactsDir(root)));
      const free = s.bavail * s.bsize;
      if (free < 2 * cfg.artifacts.minFreeBytes) (d.escalations ??= []).push({ key: 'disk:low', reason: `only ${gb(free)} free on the disk of the checks (reserve ${gb(cfg.artifacts.minFreeBytes)}); orch artifacts shows what can be removed` });
    } catch { /* no statfs */ }
  }
  const r = withCampaignLock(root, () => {
    const campaign = readCampaign(root);
    if (!campaign?.active || campaign.startedAt !== before.startedAt) return { action: 'off', reason: 'the campaign was stopped or restarted during this check' };
    if (JSON.stringify(campaign.wakes ?? null) !== JSON.stringify(before.wakes ?? null)) return { action: 'wait', reason: 'another keeper check woke the coordinator meanwhile' };
    const reported = campaign.reported ?? {};
    const fresh = d.escalations.filter(e => !reported[e.key]);
    // A reported key is forgotten only when a full look found its cause gone (a stuck report: when progress changed).
    const keep = k => !k.startsWith('busy:') && (k.startsWith('stuck:') ? k === `stuck:${d.progress}` : d.partial);
    const kept = Object.entries(reported).filter(([k]) => keep(k) && !d.escalations.some(e => e.key === k));
    const next = { ...campaign, reported: Object.fromEntries([...kept, ...d.escalations.map(e => [e.key, reported[e.key] ?? now()])]) };
    // What is running, and since when (a hung command is reported after the longest sub-agent limit).
    const at = Number(process.env.ORCH_NOW) || Date.now();
    if (d.busy) next.busy = campaign.busy?.what === d.busy ? campaign.busy : { what: d.busy, since: at };
    else delete next.busy;
    const result = { action: d.action, reason: d.reason };
    if (fresh.length) result.notify = `[orch keeper] Campaign "${campaign.scopeLabel}" needs the owner: ${fresh.map(e => e.reason).join(' · ')}.`;
    if (d.action === 'wake') {
      Object.assign(result, { next: d.next, session: campaign.session, message: wakeMessage(campaign, d) });
      next.wakes = { count: d.wakeCount, at, progress: d.progress };
      if (d.overdue) next.overdue = { ...campaign.overdue, [d.overdue]: at };
    } else if (d.action === 'escalate' && !fresh.length) {
      Object.assign(result, { action: 'wait', reason: `already reported to the owner: ${d.reason}` });
    } else if (d.action === 'done') {
      result.notify = `[orch keeper] Campaign "${campaign.scopeLabel}" is complete: ${d.reason}.`;
      Object.assign(next, { active: false, stoppedAt: now(), stopReason: 'done' });
    }
    if (result.notify) result.session = campaign.session;
    writeJson(campaignFile(root), next);
    return result;
  });
  print(r.locked ? { action: 'wait', reason: 'the campaign is being changed by another orch command' } : r.value);
  // Housekeeping after the decision is out: the scopes merged runs, earlier rounds and expired parked or set-aside runs
  // left, at most 100 per tick (the first tick after an update may find many).
  try { applyGc(gcPlan(root, cfg), { max: 100 }); } catch { /* never in the way of the decision */ }
}

// `orch card`, plus what a split means for a card that already has a run (for example one at its round limit, where
// the owner chose to split): the run is set aside so the card can come back later as the closure of its children.
// `orch card set-aside <id>` does only that step; a split that stopped half-way (a locked worktree, a tracker that
// could not be written) is finished by running it again: every step checks whether it is already done.
async function cmdCardWithRuns(root, args) {
  const cfg = loadConfig(root, { requireConfirmed: false });
  const tracker = await trackerFor(root, cfg);
  const [sub, id] = args.pos;
  if (sub === 'set-aside') {
    const st = readJson(path.join(runDir(root, need(id, 'task id')), 'state.json'), null);
    if (!st) throw new OrchError(`${id} has no run to set aside`);
    if (st.phase === 'merged') throw new OrchError(`${st.id} is merged: nothing to set aside`);
    canSetAside(root, st);
    return setAside(root, cfg, tracker, st);
  }
  const st = sub === 'split' && id && args.flags['dry-run'] !== true ? readJson(path.join(runDir(root, id), 'state.json'), null) : null;
  const open = st && st.phase !== 'merged';
  if (open && st.setAside) throw new OrchError(`${st.id} was split already and its run is half set aside: orch card set-aside ${st.id}`);
  if (open) canSetAside(root, st);
  await cmdCard(root, args, { cfg, tracker, out });
  if (!open || process.exitCode) return;
  setAside(root, cfg, tracker, st);
}

// A run may be set aside unless something is still happening to it: a sub-agent at work, an unsafe merge not settled,
// or a finish that was interrupted (its merge in progress, already committed, or a PR merge under way). Those first
// go through orch finish / orch resolve, which know how to recover them.
function canSetAside(root, st) {
  if (['working', 'checking'].includes(st.phase)) {
    throw new OrchError(`${st.id} has a ${st.phase === 'working' ? 'worker' : 'checker'} at work: wait for its report (or orch park ${st.id}) before splitting it`);
  }
  if (unresolvedUnsafe(st)) throw new OrchError(`${st.id} is parked as an unsafe merge: settle it first (orch resolve)`);
  const head = git(['rev-parse', '--verify', '--quiet', `refs/heads/${st.branch}`], root, { allowFail: true }).out;
  const interrupted = `${st.id} has an interrupted finish: run orch finish ${st.id} first (it recovers or completes it)`;
  if (head) {
    const mergeHead = path.join(git(['rev-parse', '--path-format=absolute', '--git-dir'], root), 'MERGE_HEAD');
    if (fs.existsSync(mergeHead) && fs.readFileSync(mergeHead, 'utf8').trim() === head) throw new OrchError(interrupted);
    if (st.delivery !== 'pr' && head !== st.base && mergeOf(root, st, head, st.baseBranch)) throw new OrchError(interrupted);
  }
  // A PR merge under way: a 'merging' intent not closed by a 'merge-failed' (GitHub confirmed nothing was merged).
  if (st.events.filter(e => ['merging', 'merge-failed'].includes(e.kind)).at(-1)?.kind === 'merging') throw new OrchError(interrupted);
}

function setAside(root, cfg, tracker, st) {
  if (!st.setAside) {
    st.setAside = { tag: `before-split-${now().replace(/[^0-9]/g, '').slice(0, 14)}`, at: now() };
    event(st, 'set-aside', { tag: st.setAside.tag }); saveState(root, st);
  }
  const { tag } = st.setAside;
  const stop = what => new OrchError(`${st.id}: ${what}. Nothing was lost; fix that, then: orch card set-aside ${st.id} (it goes on from there)`);
  const notes = [];
  git(['worktree', 'prune'], root, { allowFail: true }); // a worktree folder removed by hand
  if (st.worktree && fs.existsSync(st.worktree)) {
    const moved = git(['worktree', 'move', st.worktree, `${st.worktree}-${tag}`], root, { allowFail: true });
    if (moved.code !== 0) throw stop(`could not move the worktree ${st.worktree} (${moved.err.trim()})`);
    notes.push(`worktree kept at ${st.worktree}-${tag}`);
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${st.branch}`], root, { allowFail: true }).code === 0) {
    const renamed = git(['branch', '-m', st.branch, `${st.branch}-${tag}`], root, { allowFail: true });
    if (renamed.code !== 0) throw stop(`could not rename the branch ${st.branch} (${renamed.err.trim()})`);
    notes.push(`branch kept as ${st.branch}-${tag}`);
  }
  if (st.delivery === 'pr') notes.push(`its pull request and remote branch stay as they are: close them before ${st.id} starts again`);
  let archive = path.join(orchDir(root), 'archive', `${st.id}-${tag}`);
  for (let i = 2; fs.existsSync(archive); i++) archive = path.join(orchDir(root), 'archive', `${st.id}-${tag}-${i}`);
  try {
    tracker.setStatus(st.id, cfg.tracker.status.todo);
    tracker.comment(st.id, `split: the run of round ${st.round} was set aside (${path.relative(root, archive)}); this card now closes its split cards`);
  } catch (e) { throw stop(`the tracker could not be updated (${e.message})`); }
  // Last: while the run is in runs/, orch card set-aside can finish the steps above.
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(runDir(root, st.id), archive);
  out(`${st.id}: its run (${st.phase}, round ${st.round}) was set aside in ${path.relative(root, archive)}${notes.length ? `; ${notes.join('; ')}` : ''}`,
    `${st.id} is back in ${cfg.tracker.status.todo} and starts again only when its split cards are done`);
}

// ---------------------------------------------------------------------------------------------------- artifacts cleanup

// What the cleanup knows about each run: its phase and round, when its previous round started (that round and the
// current one keep their scopes), when it was parked; and the runs a split set aside (archive/<id>-before-split-*).
function gcRuns(root) {
  const runs = {}; const archived = {};
  const runsDir = path.join(orchDir(root), 'runs');
  for (const d of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    const st = readJson(path.join(runsDir, d, 'state.json'), null);
    if (!st?.id) continue;
    const starts = st.events.filter(e => ['start', 'fix'].includes(e.kind)).map(e => Date.parse(e.t) || 0);
    // Parked without a park event (an unsafe merge parks itself): the time of its last event, never "long ago".
    const parked = [...st.events].reverse().find(e => e.kind === 'park') ?? st.events.at(-1);
    runs[st.id.toUpperCase()] = {
      phase: st.phase, round: st.round, finishPending: st.finishPending, startedAt: starts[0] ?? 0,
      keepFrom: starts.at(-2) ?? starts.at(-1) ?? 0, parkedAt: Date.parse(parked?.t ?? '') || Date.now(),
      hold: unresolvedUnsafe(st) || unresolvedUntested(st),
    };
  }
  const archive = path.join(orchDir(root), 'archive');
  for (const d of fs.existsSync(archive) ? fs.readdirSync(archive) : []) {
    const id = d.split('-before-split-')[0].toUpperCase();
    const at = Date.parse(readJson(path.join(archive, d, 'state.json'), null)?.setAside?.at ?? '') || fs.statSync(path.join(archive, d)).mtimeMs;
    archived[id] = Math.max(archived[id] ?? 0, at);
  }
  return { runs, archived };
}

function gcPlan(root, cfg, { merged = null, only = null } = {}) {
  const dir = artifactsDir(root);
  if (!fs.existsSync(dir)) return [];
  const { runs, archived } = gcRuns(root);
  if (merged) runs[merged.toUpperCase()] = { ...runs[merged.toUpperCase()], phase: 'merged', finishPending: [], hold: false }; // its finish is cleaning up now
  return planGc({ artifactsDir: fs.realpathSync(dir), worktreeRoot: path.resolve(root, cfg.worktreeRoot), runs, archived, keepDays: cfg.artifacts.keepDays ?? 14, only: only?.toUpperCase() ?? null });
}

// The cleanup of one run's scopes (a merge, a new round); never fails the command that calls it.
function cleanRun(root, cfg, id, { merged = false } = {}) {
  try { return applyGc(gcPlan(root, cfg, { merged: merged ? id : null, only: id })); } catch { return { deleted: 0, freed: 0 }; }
}

const gb = n => `${(n / 1e9).toFixed(1)} GB`;

// `orch artifacts`: what the command scopes hold and what the cleanup would do. `orch artifacts gc`: delete what belongs to
// merged runs, earlier rounds and expired parked runs. `--unowned` also deletes the scopes no run owns (older releases,
// the main checkout): only on the owner's explicit request.
async function cmdArtifacts(root, { pos, flags }) {
  const cfg = loadConfig(root, { requireConfirmed: false });
  const plan = gcPlan(root, cfg);
  if (pos[0] === 'gc') {
    const r = applyGc(plan, { unowned: flags.unowned === true });
    out(`deleted ${r.deleted} scope(s), ${gb(r.freed)} freed${flags.unowned ? ' (unowned included, on the owner\'s request)' : ''}`);
    return;
  }
  if (pos[0]) throw new OrchError('orch artifacts [gc [--unowned]]');
  const groups = {};
  for (const x of plan) {
    const k = x.action === 'unowned' ? 'unowned' : x.action === 'delete' ? 'deletable' : 'kept';
    (groups[k] ??= { n: 0, bytes: 0 }).n++;
    groups[k].bytes += scopeBytes(x.scope);
  }
  out(`artifacts in ${artifactsDir(root)}: ${plan.length} scope(s)`,
    ...['deletable', 'kept', 'unowned'].filter(k => groups[k]).map(k => `  ${k.padEnd(9)} ${String(groups[k].n).padStart(5)}  ${gb(groups[k].bytes)}`),
    groups.deletable ? 'next: orch artifacts gc (the keeper also runs it)' : null,
    groups.unowned ? 'unowned scopes are deleted only on the owner\'s request: orch artifacts gc --unowned' : null);
}

function need(v, what) { if (!v) throw new OrchError(`missing ${what}`); return v; }

const COMMANDS = { init: cmdInit, config: cmdConfig, next: cmdNext, start: cmdStart, record: cmdRecord, gate: cmdGate, push: cmdPush, resolve: cmdResolve, campaign: cmdCampaign, keeper: cmdKeeper, fix: cmdFix, finish: cmdFinish, park: cmdPark, status: cmdStatus, prompt: cmdPrompt, harness: cmdHarness,
  card: cmdCardWithRuns, artifacts: cmdArtifacts,
};

export async function runCli() {
  const [name, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[name];
  if (!fn) {
    out(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//   orch')).map(l => l.slice(5)).join('\n'));
    process.exit(name ? 1 : 0);
  }
  try {
    const root = primaryRoot();
    // The coordinator's activity, for the campaign keeper: any orch command but the keeper's own.
    if (!['keeper', 'campaign'].includes(name) && fs.existsSync(orchDir(root))) { try { fs.writeFileSync(path.join(orchDir(root), 'activity'), `${name} ${now()}\n`); } catch { /* read-only checkout */ } }
    await fn(root, parseArgs(rest));
  } catch (e) {
    if (!(e instanceof OrchError)) throw e;
    console.error(`orch: ${e.message}`);
    process.exit(e.exitCode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
