// Small helpers shared by the orch scripts. Node built-ins only: the skill runs inside agent containers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class OrchError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const RUN_CMD = fileURLToPath(new URL('./run-cmd.mjs', import.meta.url));

// Credentials of the agent and its tools never reach checks and harnesses: they run code the worker just wrote.
// Only these names are removed (a project's own keys, read by its tests, stay); config env.strip adds names or
// /regex/ entries, env.keep exempts names. Files the agent can read (a gh login, a CLI token) are not covered.
const AGENT_SECRETS = /^(OPENCLAW_\w*(TOKEN|PASSWORD|SECRET|KEY)\w*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|TRELLO_\w+|VERCEL_TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|REV4A_\w*(TOKEN|KEY|SECRET)\w*)$/;
let envPolicy = { strip: [], keep: [] };
let artifactPolicy = { enabled: false, minFreeBytes: 0, disposable: [] };
export function setArtifactPolicy(policy) { artifactPolicy = policy; }
export function setEnvPolicy(policy) { envPolicy = { strip: policy?.strip ?? [], keep: policy?.keep ?? [] }; }

export function commandEnv(extra, base = process.env) {
  const extraStrip = envPolicy.strip.map(p => (p.startsWith('/') && p.endsWith('/') ? new RegExp(p.slice(1, -1)) : p));
  const drop = name => !envPolicy.keep.includes(name)
    && (AGENT_SECRETS.test(name) || extraStrip.some(p => (typeof p === 'string' ? p === name : p.test(name))));
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!drop(k)) env[k] = v;
  return { ...env, ...(extra ?? {}) };
}

// The values of the agent's credential variables cut out of a text that leaves the machine (a PR body, a comment).
export function redactSecrets(text) {
  return Object.entries(process.env).filter(([k, v]) => AGENT_SECRETS.test(k) && v && v.length >= 8)
    .reduce((t, [, v]) => t.split(v).join('[redacted]'), String(text));
}

// The kernel's count of OOM kills in this container's memory cgroup (v2, then v1), or null outside Linux.
function oomKills() {
  for (const f of ['/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory/memory.oom_control']) {
    try { const m = fs.readFileSync(f, 'utf8').match(/oom_kill (\d+)/); if (m) return Number(m[1]); } catch { /* absent */ }
  }
  return null;
}

// A shell command with a hard timeout, in its own process group (run-cmd.mjs). Output is captured, never streamed
// into the coordinator's context. `infra` says the machine, not the code, ended it: an OOM kill in the container, or
// a SIGKILL nobody asked for. Such a run proves nothing about the change and must not cost a correction round.
export function sh(cmd, { cwd, timeoutSec = 900, env } = {}) {
  const t0 = Date.now();
  const oomBefore = oomKills();
  const r = spawnSync(process.execPath, [RUN_CMD, String(timeoutSec), cmd, JSON.stringify(artifactPolicy)], {
    cwd, encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, env: commandEnv(env),
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timedOut = r.status === 124 || r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM');
  const code = timedOut ? 124 : (r.status ?? 1);
  const oomAfter = oomKills();
  let infra = null;
  if (code === 125 && (r.stderr ?? '').includes('orch: ARTIFACT_INFRA:')) infra = 'artifact infrastructure unavailable; see the command log';
  else if (oomBefore !== null && oomAfter !== null && oomAfter > oomBefore) infra = 'out of memory: the kernel killed a process in this container';
  else if (!timedOut && (code === 137 || r.signal === 'SIGKILL')) infra = 'killed by SIGKILL (out of memory, or stopped from outside)';
  return { code, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut, infra, ms: Date.now() - t0 };
}

// git with argv (never a shell string). Throws unless allowFail.
// Commands that talk to a remote: a stalled network or a credential prompt must fail, never hang an orch command.
const NETWORK = new Set(['push', 'fetch', 'ls-remote', 'pull', 'clone']);
let networkTimeoutSec = 120;
export function setNetworkTimeout(sec) { const n = Number(sec); if (Number.isFinite(n) && n > 0) networkTimeoutSec = n; } // "300" from hand-edited JSON counts
export const getNetworkTimeout = () => networkTimeoutSec;

// ssh options that make a dead connection fail, used only when the user has no ssh command of their own (GIT_SSH,
// GIT_SSH_COMMAND or core.sshCommand win: a deploy key or plink must keep working). BatchMode refuses passphrase and
// unknown-host prompts, which nobody can answer in an agent; ssh-agent and known_hosts work as usual.
function sshEnv(cwd) {
  if (process.env.GIT_SSH || process.env.GIT_SSH_COMMAND) return {};
  const own = spawnSync('git', ['config', '--get', 'core.sshCommand'], { cwd, encoding: 'utf8' });
  if (own.status === 0 && own.stdout.trim()) return {};
  return { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=2' };
}

// raw: stdout exactly as git wrote it (a -z name list must keep a leading space or tab of its first name).
export function git(args, cwd, { allowFail = false, raw = false } = {}) {
  const net = NETWORK.has(args[0]);
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    // git's own limits stop a stalled transfer inside its helper processes (git-remote-https, ssh), which a timeout
    // on git alone cannot reach; the timeout (limits.networkTimeoutSec) stays as the last resort.
    ...(net ? { timeout: networkTimeoutSec * 1000, env: {
      ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30', ...sshEnv(cwd),
    } } : {}),
  });
  if (net && (r.error?.code === 'ETIMEDOUT' || r.signal)) r.stderr = `timed out after ${networkTimeoutSec} s (network or credentials; limits.networkTimeoutSec)\n${r.stderr ?? ''}`;
  if (allowFail) return { code: r.status ?? 1, out: raw ? (r.stdout ?? '') : (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  if (r.status !== 0) throw new OrchError(`git ${args.join(' ')}: ${((r.stderr || r.stdout) ?? '').trim()}`);
  return (r.stdout ?? '').replace(/\n$/, '');
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new OrchError(`${file} is not valid JSON: ${e.message}`); }
}

export const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

// {{name}} placeholders. A function replacement, so `$` in values is never interpreted.
export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in values ? String(values[k]) : `{{${k}}}`));
}

export const lastLines = (text, n) => text.trimEnd().split('\n').slice(-n).join('\n');

export function minutes(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// Append a line to <git-common-dir>/info/exclude once (shared by every worktree of the repo).
export function excludeOnce(root, line) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const file = path.join(common, 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
}
