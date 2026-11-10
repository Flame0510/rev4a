// Shared helpers for the rev4a-openclaw-upgrade scripts. Node built-ins only (Node 18 or later for
// fetch, AbortSignal.timeout and base64url; the repository itself requires 22): the scripts run
// from any checkout or worktree, with or without node_modules.
//
// Exit codes, the same in every script:
//   0  ran fine (findings, if any, are in the report);
//   1  usage or environment error (bad flag, missing tool, output inside a git tree, network down);
//   2  the result would not be trustworthy (agent down, Rev4a unreachable, snapshot incomplete…);
//   3  triage.mjs only: escalate to the full track.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Errors and the main wrapper ─────────────────────────────────────────────

/** A bad command line or a missing tool: exit 1. */
export class UsageError extends Error {}
/** The script ran, but what it would write cannot be trusted: exit 2. */
export class Untrustworthy extends Error {}

/**
 * Parse `--name value`, `--name=value` and `--flag`. `spec` maps each accepted flag to
 * 'string' or 'boolean'; anything else is a UsageError, and so is a string flag without a value
 * (a trailing `--out` used to become `true` and crash later in path.resolve).
 * Positional arguments land in `_`.
 */
export function parseArgs(argv, spec = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const type = key === 'help' ? 'boolean' : spec[key];
    if (!type) throw new UsageError(`unknown option --${key}`);
    if (type === 'boolean') {
      if (eq > 0) throw new UsageError(`--${key} takes no value`);
      out[key] = true;
      continue;
    }
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else { value = argv[i + 1]; i++; }
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

/**
 * Run a script body with the shared exit-code rules. `fn(args)` returns the exit code (default 0).
 * process.exitCode is set instead of calling process.exit, so a long report piped to another
 * program is never cut short.
 */
export async function main(usage, spec, fn) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), spec);
  } catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${redact(e.message)}\n\n${usage}`); process.exitCode = 1; return; }
    throw e;
  }
  if (args.help) { console.log(usage); return; }
  try {
    process.exitCode = (await fn(args)) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${redact(e.message)}`); process.exitCode = 1; return; }
    if (e instanceof Untrustworthy) { console.error(`NOT TRUSTWORTHY: ${redact(e.message)}`); process.exitCode = 2; return; }
    console.error(redact(e?.stack || String(e)));
    process.exitCode = 1;
  }
}

// ── Processes ───────────────────────────────────────────────────────────────

/**
 * Run a command; never throws. `rc` is the exit status (-1 when it could not start or timed out).
 * stdout and stderr are kept apart, so a JSON answer is parsed from stdout only; `out` joins them
 * for people to read.
 */
export function run(cmd, args, { timeoutMs = 120_000, input } = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return { rc: 0, stdout, stderr: '', out: stdout, timedOut: false };
  } catch (e) {
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const timedOut = e.code === 'ETIMEDOUT' || (e.signal === 'SIGTERM' && e.status === null);
    const stderr = (typeof e.stderr === 'string' ? e.stderr : '')
      || (e.code === 'ENOENT' ? `${cmd}: command not found`
        : timedOut ? `${cmd}: timed out after ${timeoutMs} ms`
          : typeof e.status !== 'number' ? String(e.message ?? '') : '');
    return { rc: typeof e.status === 'number' ? e.status : -1, stdout, stderr, out: `${stdout}${stderr}`, timedOut, missing: e.code === 'ENOENT' };
  }
}

/** Judge only a newly recorded terminal agent-cron run, never an older session or a failed turn. */
export function seededAgentCronResult(entries, previousEntries = []) {
  const key = (e) => e.runId || `${e.sessionId}:${e.runAtMs ?? e.ts}`;
  const previous = new Set(previousEntries.map(key));
  const entry = entries.find((e) => e.sessionId && !previous.has(key(e)) && e.action === 'finished');
  if (!entry) return { status: 'pending', detail: 'no new finished run with a sessionId' };
  if (entry.error || ['error', 'failed', 'aborted', 'cancelled', 'canceled'].includes(entry.status)
    || ['error', 'failed', 'aborted', 'cancelled', 'canceled'].includes(entry.completionStatus)) {
    return { status: 'fail', detail: String(entry.error || `run status ${entry.status}, completionStatus ${entry.completionStatus}`) };
  }
  if (!['ok', 'success', 'succeeded', 'complete', 'completed', 'done'].includes(entry.status)) {
    return { status: 'fail', detail: `finished run has no verified success status (${entry.status ?? 'missing'})` };
  }
  return { status: 'ok', detail: `session ${entry.sessionId}` };
}

/** Read the complete release list through gh api (also supported by older gh versions). */
export function githubReleaseBodies() {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const result = run('gh', ['api', `repos/openclaw/openclaw/releases?per_page=100&page=${page}`]);
    if (result.missing) throw new UsageError('--notes needs the GitHub CLI (gh), signed in');
    if (result.rc !== 0) throw new UsageError(`gh api releases page ${page} failed: ${result.out.slice(-300)}`);
    let rows;
    try { rows = JSON.parse(result.stdout); } catch { throw new UsageError(`gh api releases page ${page} returned invalid JSON`); }
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.tag_name !== 'string' || (r.body != null && typeof r.body !== 'string'))) {
      throw new UsageError(`gh api releases page ${page} returned an unexpected release list`);
    }
    releases.push(...rows.map((r) => ({ tag: r.tag_name, body: r.body ?? '' })));
    if (rows.length < 100) return releases;
  }
  throw new UsageError('GitHub release list exceeds 100 pages: cannot claim complete release notes');
}

/** Resolve OpenClaw's release-note wrapper to its changelog, pinned to the release tag. */
export function githubReleaseChangelog(tag, body) {
  if (!body.trim()) throw new UsageError(`release ${tag} has an empty body: release notes are unverified`);
  if (!body.includes('openclaw-release-publication:docs-v1')) return null;
  const version = tag.replace(/^v/, '');
  if (!versionParts(version)) throw new UsageError(`invalid release tag ${tag}`);
  const expected = `https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/${version}.md`;
  if (!body.includes(expected)) throw new UsageError(`release ${tag} links no recognized changelog`);
  const result = run('gh', ['api', `repos/openclaw/openclaw/contents/CHANGELOG/${version}.md?ref=${encodeURIComponent(tag)}`]);
  if (result.rc !== 0) throw new UsageError(`gh api changelog ${tag} failed: ${result.out.slice(-300)}`);
  let file;
  try { file = JSON.parse(result.stdout); } catch { throw new UsageError(`changelog ${tag} returned invalid JSON`); }
  if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new UsageError(`changelog ${tag} returned no base64 file`);
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  if (!text.trim()) throw new UsageError(`changelog ${tag} is empty`);
  return text;
}

// In-container deadline. A host-side timeout kills only the `docker` client: the `openclaw`
// process inside the agent keeps running and stacks 100-360 MB with the next one, which is what
// once got an owner's Gateway killed. Rev4a does the same (lib/exec-timeout.js). coreutils
// `timeout` is in the Debian base image; the fallback keeps older or custom images working.
const DEADLINE = 'T="$1"; shift; if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$T" "$@"; else exec "$@"; fi';

/**
 * Run `openclaw <args>` inside an agent against its own Gateway (port 3000, agent token), the way
 * Rev4a does (lib/gateway-cli.ts). Arguments travel as argv, never through a shell string.
 */
export function gw(container, args, { timeoutS = 90 } = {}) {
  const script = 'export OPENCLAW_GATEWAY_PORT=3000; '
    + 'if [ -f /root/.agent-token ]; then OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]"); export OPENCLAW_GATEWAY_TOKEN; fi; '
    + DEADLINE;
  return run('docker', ['exec', container, 'sh', '-c', script, 'sh', String(timeoutS), 'openclaw', ...args], { timeoutMs: (timeoutS + 20) * 1000 });
}

/** Run a shell script inside the container, under the same in-container deadline. */
export function inContainer(container, script, { timeoutS = 60 } = {}) {
  return run('docker', ['exec', container, 'sh', '-c', DEADLINE, 'sh', String(timeoutS), 'sh', '-c', script], { timeoutMs: (timeoutS + 20) * 1000 });
}

// ── JSON in noisy output ────────────────────────────────────────────────────

/**
 * Every balanced `{…}` / `[…]` span in a text, in one linear pass. Strings are skipped while
 * inside a span; a closer of the wrong kind, or a newline inside a string (a stray quote in a log
 * line), drops the spans open at that point. Returns `{ start, end, lineStart }` for each span;
 * nested spans are included, the caller prefers the outer ones.
 */
function bracketSpans(text) {
  const spans = [];
  const stack = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      else if (c === '\n') { inString = false; stack.length = 0; }
      continue;
    }
    if (c === '{' || c === '[') { stack.push(i); continue; }
    if (!stack.length) continue;
    if (c === '"') { inString = true; continue; }
    if (c === '}' || c === ']') {
      const start = stack.pop();
      if (text[start] !== (c === '}' ? '{' : '[')) { stack.length = 0; continue; }
      let j = start - 1;
      while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
      spans.push({ start, end: i + 1, lineStart: j < 0 || text[j] === '\n' || text[j] === '\r' });
    }
  }
  return spans;
}

const isEmptyValue = (v) => v && typeof v === 'object' && Object.keys(v).length === 0;

/**
 * The JSON value a command printed, from a text that may carry banners or log lines before and
 * after it. Rules, in order:
 *   1. a value that starts a line beats one that starts mid-line (log lines embed JSON after a
 *      prefix: `[gateway] worker startup state: {"workerCount":8}`);
 *   2. among those, the largest wins, so a value inside another value is never taken while the
 *      outer one parses;
 *   3. an empty `[]` or `{}` is kept only when no non-empty value of the same rank parses.
 * Returns undefined when nothing parses. Linear in the text plus one JSON.parse per candidate
 * tried (at most 200).
 */
export function firstJson(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const spans = bracketSpans(text);
  for (const rank of [true, false]) {
    const cands = spans.filter((s) => s.lineStart === rank).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    let empty;
    let tried = 0;
    for (const s of cands) {
      if (++tried > 200) break;
      let v;
      try { v = JSON.parse(text.slice(s.start, s.end)); } catch { continue; }
      if (isEmptyValue(v)) { empty ??= v; continue; }
      return v;
    }
    if (empty !== undefined) return empty;
  }
  return undefined;
}

/**
 * Why a parsed answer is a failure even with exit status 0: `{ok:false}` or a top-level `error`.
 * Null when it looks like a success.
 */
export function jsonProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const msg = (e) => redact(typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)).slice(0, 200);
  if (value.ok === false) return `ok:false${value.error ? ` (${msg(value.error)})` : value.reason ? ` (${msg(value.reason)})` : ''}`;
  if (value.error) return `error: ${msg(value.error)}`;
  return null;
}

// ── JSON shapes ─────────────────────────────────────────────────────────────

/** Missing CPU measurements must never certify an idle snapshot. */
export function snapshotSettleSample(agent, gateway, stats, now = Date.now()) {
  const startedAt = Date.parse(agent?.startedAt);
  const uptimeS = agent?.running && Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 1000) : null;
  const match = stats?.rc === 0 && !stats.timedOut && /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(stats.stdout ?? '');
  const cpu = match ? Number(match[1]) : null;
  const startupz = gateway?.rc === 0 && !gateway.timedOut ? firstJson(gateway.stdout) ?? null : null;
  return { uptimeS, cpu, startupz };
}

/** Database read errors are nested by path, unlike ordinary CLI errors. */
export function databaseVersionsProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid database version map';
  const failed = Object.entries(value).filter(([, row]) => !row || typeof row !== 'object' || row.error || !Number.isInteger(row.user_version) || !Array.isArray(row.tables));
  return failed.length ? `unreadable database(s): ${failed.map(([name]) => name).join(', ')}` : null;
}

/** Check observation continuity/deadline before interpreting a terminal operation status. */
export function observationWindowProblem({ nowMs, lastObservedAtMs, phaseStartedAtMs, phaseLimitMs = 600000, maxGapMs = 120000 }) {
  if (nowMs - lastObservedAtMs > maxGapMs) return `observation gap ${nowMs - lastObservedAtMs}ms: inspect host sleep or blocked calls; preserve state`;
  if (phaseStartedAtMs != null && nowMs - phaseStartedAtMs > phaseLimitMs) return `operation observation window exceeded ${phaseLimitMs}ms: stop before recovery or another test`;
  return null;
}

/** An unseeded fresh-create load probe need not contain the evaluator's workspace skill. */
export function seedSkillExpected(seedRecord, container, skillsList, name = 'rev4a-upgrade-seed') {
  if (seedRecord?.container === container && seedRecord.steps?.['workspace skill']?.status === 'ok') return true;
  if (!Array.isArray(skillsList?.skills)) return true; // Unknown is not evidence of an unseeded agent.
  return skillsList.skills.some(s => s.name === name);
}

/** Explicitly rebuilding usage caches are partial answers, not stable migration baselines. */
export function usageCacheProblem(value) {
  const cache = value?.cacheStatus;
  if (!cache) return null; // Older replies may lack this metadata; retain the raw answer.
  if ((cache.status && cache.status !== 'fresh') || cache.pendingFiles > 0 || cache.staleFiles > 0) {
    return `usage cache is not fresh: ${cache.status ?? 'unknown'}, pending=${cache.pendingFiles ?? '?'}, stale=${cache.staleFiles ?? '?'}`;
  }
  return null;
}

// Object keys that are data (ids, session keys, container names, account ids, dates, model refs,
// file names), not schema: they become `<key>` so two samples with different data compare equal.
export const DATA_KEY = /^[0-9a-f-]{8,}$|^agent_[0-9a-f]{8}$|^agent:|:|@|^\d{4}-\d\d-\d\d|^\d+$|^[a-z0-9-]+\/|\.(md|sqlite|json|jsonl)$/i;

/** Every JSON path with the set of types seen there; arrays collapse to `[]`, data keys to `<key>`. */
export function shapeMap(value) {
  const acc = new Map();
  const walk = (v, p) => {
    const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (!acc.has(p)) acc.set(p, new Set());
    acc.get(p).add(t);
    if (t === 'array') for (const x of v.slice(0, 50)) walk(x, `${p}[]`);
    else if (t === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${DATA_KEY.test(k) ? '<key>' : k}`);
  };
  walk(value, '$');
  return acc;
}

/** The same, as sorted `path: type|type` lines (the `.shape` files people read). */
export function shapeOf(value) {
  return [...shapeMap(value)].map(([p, t]) => `${p}: ${[...t].sort().join('|')}`).sort();
}

// ── Secrets ─────────────────────────────────────────────────────────────────

// Field names whose values are secrets. Exact names only: a loose "key" would also hit
// declarationKey or sessionKey, which compare.mjs reads back from the saved output. `value`
// stays: it is the secret store's value column (inventory S2), even if it masks some plain data.
const SECRET_FIELDS = 'token|botToken|controlToken|accessToken|refreshToken|idToken|access|refresh|secret|clientSecret|password|apiKey|api_key|value|authorization'; // secret-ok: field-name regex, no values
// Environment-style names: TRELLO_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, DB_PASSWORD…
const ENV_SECRET = '[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD|_PAT)'; // secret-ok: environment-name regex, no values

const secretField = new RegExp(`^(?:${SECRET_FIELDS}|${ENV_SECRET})$`, 'i');

/** Find a quoted token once, including an incomplete diagnostic tail. */
function quotedEnd(text, start) {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** Skip one secret value without parsing or rescanning any nested suffix. */
function secretValueEnd(text, start) {
  if (text[start] === '"') return quotedEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let end = start;
    while (end < text.length && !/[\s,}\]]/.test(text[end])) end++;
    return end;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"') i = quotedEnd(text, i) - 1;
    else if (text[i] === '{' || text[i] === '[') depth++;
    else if ((text[i] === '}' || text[i] === ']') && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Bounded key-based pass, followed by a fixed number of text substitutions.
 * No fragment is reparsed for each opening bracket. Encoded JSON strings recurse at most
 * 16 levels; deeper diagnostic strings are masked in full rather than leaking or stalling.
 */
export function redact(text, level = 0) {
  const input = String(text);
  const chunks = [];
  let copied = 0;
  for (let i = 0; i < input.length;) {
    if (input[i] !== '"') { i++; continue; }
    const end = quotedEnd(input, i);
    const token = input.slice(i, end);
    let decoded;
    // Reconsider every closing quote as a possible key opening. A diagnostic prefix
    // may contain an unmatched quote; greedily consuming pairs would hide the next key.
    // Each span between quotes is visited at most twice, so malformed text stays linear.
    const nextQuote = end - 1 > i && input[end - 1] === '"' ? end - 1 : end;
    try { decoded = JSON.parse(token); } catch { i = nextQuote; continue; }
    let next = end;
    while (next < input.length && /\s/.test(input[next])) next++;
    if (input[next] === ':' && secretField.test(decoded)) {
      next++;
      while (next < input.length && /\s/.test(input[next])) next++;
      chunks.push(input.slice(copied, next), '"<redacted>"');
      i = secretValueEnd(input, next);
      copied = i;
    } else {
      // Only escaped strings can conceal JSON from this pass. Ordinary assignments,
      // bearer values, etc. are handled by the fixed text substitutions below.
      if (token.includes('\\')) {
        const safe = level >= 16 ? '<redacted>' : redact(decoded, level + 1);
        if (safe !== decoded) { chunks.push(input.slice(copied, i), JSON.stringify(safe)); copied = end; }
      }
      i = nextQuote;
    }
  }
  chunks.push(input.slice(copied));
  const out = chunks.join('');
  // Also cover incomplete JSON error tails. Redact before truncating any diagnostic.
  return out
    .replace(new RegExp(`(\\b(?:${SECRET_FIELDS}|${ENV_SECRET})=)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s&"']+)`, 'gi'), '$1<redacted>')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/([?#&]token=)[^&"\s]+/g, '$1<redacted>')
    .replace(/[^\s"]+/g, word => {
      // One scan per whitespace-delimited token also bounds malformed URI diagnostics.
      const scheme = word.indexOf('://');
      const at = word.lastIndexOf('@');
      if (scheme < 0 || at < scheme + 3) return word;
      const colon = word.indexOf(':', scheme + 3);
      return colon > scheme + 3 && colon < at ? word.slice(0, colon + 1) + '<redacted>@' + word.slice(at + 1) : word;
    })
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<redacted-key>')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-bot-token>');
}

// ── Where files go ──────────────────────────────────────────────────────────

/**
 * The base folder for downloads and runs: $REV4A_UPGRADE_WORK, else <tmpdir>/rev4a-openclaw-upgrade.
 * Never inside a git tree: review tooling may stage the whole worktree, and these files hold
 * hundreds of MB of downloads and agent data. On hosts where /tmp is a tmpfs (Debian 13, Fedora,
 * Arch) the downloads sit in RAM: set REV4A_UPGRADE_WORK to a disk folder there.
 */
export function baseDir(...parts) {
  return path.join(process.env.REV4A_UPGRADE_WORK || path.join(os.tmpdir(), 'rev4a-openclaw-upgrade'), ...parts);
}

/** The run's work directory: --work, else <base>/run. Every report of one evaluation lands here. */
export function workDir(args) {
  const dir = path.resolve(typeof args.work === 'string' ? args.work : baseDir('run'));
  assertOutsideGit(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The git tree a path belongs to (its own folder or its nearest existing parent), or null. */
export function gitTreeOf(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Refuse an output path inside a git tree (exit 1). */
export function assertOutsideGit(p) {
  const tree = gitTreeOf(p);
  if (tree) throw new UsageError(`${p} is inside the git tree ${tree}: write reports and downloads outside any repository (default ${baseDir()})`);
}

/**
 * Write `<name>.md` and `<name>.json` side by side. `mdPath` may come from --out; the JSON goes
 * next to it with the same base name. Returns both paths.
 */
export function writeReport(mdPath, markdown, facts) {
  const md = path.resolve(mdPath);
  assertOutsideGit(md);
  fs.mkdirSync(path.dirname(md), { recursive: true });
  const json = md.replace(/\.md$/i, '') + '.json';
  fs.writeFileSync(md, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  fs.writeFileSync(json, JSON.stringify(facts, null, 1) + '\n');
  console.log(`-> ${md}\n-> ${json}`);
  return { md, json };
}

// ── The Rev4a repository ────────────────────────────────────────────────────

/**
 * The Rev4a checkout these scripts belong to, found from the script's own location (never from
 * the current directory: run from elsewhere, a git error used to become the path, and run from
 * another repository every key read as "not referenced by Rev4a"). `override` is --repo.
 */
export function repoRoot(override) {
  const root = path.resolve(override || fileURLToPath(new URL('../../..', import.meta.url)));
  if (!fs.existsSync(path.join(root, 'lib', 'agent-setup.ts'))) {
    throw new UsageError(`${root} is not a Rev4a checkout (no lib/agent-setup.ts): pass --repo <rev4a checkout>`);
  }
  return root;
}

// Where Rev4a code that talks to OpenClaw lives (tests and scripts excluded by the callers).
export const REV4A_CODE = ['lib', 'app', 'daemon.js', 'server.js', 'bin', 'terminal-ws-server.js', 'instrumentation.ts', 'agent-templates', 'rev4a-rules'];

/**
 * `git grep` in the Rev4a checkout. Returns the matching lines (`file:line:text`, or file names
 * with filesOnly); an empty list means no match. Any failure other than "no match" (exit 1)
 * throws: a broken grep must never read as "Rev4a does not use this".
 */
export function gitGrep(repo, needle, { fixed = true, word = false, filesOnly = false, scope = REV4A_CODE } = {}) {
  const existing = scope.filter((s) => fs.existsSync(path.join(repo, s)));
  const r = run('git', ['-C', repo, 'grep', '-I', filesOnly ? '-l' : '-n', ...(fixed ? ['-F'] : ['-E']), ...(word ? ['-w'] : []), '-e', needle, '--', ...existing]);
  if (r.rc === 1 && !r.stderr.trim()) return [];
  if (r.rc !== 0) throw new Error(`git grep failed in ${repo} (rc ${r.rc}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.split('\n').filter(Boolean).filter((l) => !/(^|\/)(test|tests)\/|\.test\.|^scripts\//.test(l));
}

/** references/deps.json: the machine-readable list of what Rev4a depends on. */
export function loadDeps() {
  const file = fileURLToPath(new URL('../references/deps.json', import.meta.url));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── Versions ────────────────────────────────────────────────────────────────

// Same rule as Rev4a's compareVersions (lib/agent-versions.ts): `-N` is a fourth part, missing = 0.
// Anchored: a whole version (a git tag's `v` allowed), never `x2026.10.10-beta` or `2026.10.100`.
const VERSION_RE = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;
export function versionParts(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null;
}
/** The first version inside a text (`OpenClaw 2026.10.10 (1391f7c)` → `2026.10.10`), or null. */
export function versionIn(text) {
  const m = /(?:^|[^\d.])(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)(?![\d.])/.exec(String(text ?? ''));
  return m ? m[1] : null;
}
/** Negative when a is older than b. Unparseable sorts oldest. */
export function compareVersions(a, b) {
  const pa = versionParts(a) ?? [-1, -1, -1, -1];
  const pb = versionParts(b) ?? [-1, -1, -1, -1];
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
/** `2026.10` for `2026.10.10-1`: the release line. */
export const versionLine = (v) => { const p = versionParts(v); return p ? `${p[0]}.${p[1]}` : null; };

// ── Config schema ───────────────────────────────────────────────────────────

/**
 * The openclaw.json schema of a release: from a file (`openclaw config schema --json` saved
 * earlier; offline and in tests) or from an image (runs the bare CLI with no network).
 */
export function loadSchema({ file, image }) {
  if (file) {
    const s = firstJson(fs.readFileSync(path.resolve(file), 'utf8'));
    if (!s || typeof s !== 'object' || !s.properties) throw new UsageError(`${file} does not hold a JSON schema with properties`);
    return s;
  }
  const r = run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'openclaw', image, 'config', 'schema', '--json'], { timeoutMs: 300_000 });
  if (r.missing) throw new UsageError('docker is not available: pass --from-schema/--to-schema files instead');
  const s = firstJson(r.stdout);
  if (!s || !s.properties) throw new Untrustworthy(`could not read the schema from ${image} (rc ${r.rc}): ${r.out.slice(-300)}`);
  return s;
}

/**
 * Flatten a JSON schema to path → { types, enum, default, open }. Maps become `<key>`, arrays `[]`.
 * `open` marks an object that accepts any key below it (`additionalProperties: true` or `{}`, or
 * an object with neither properties nor additionalProperties): paths under it are accepted but
 * not checked.
 */
export function flattenSchema(schema) {
  const defs = schema.definitions ?? schema.$defs ?? {};
  const out = new Map();
  const seen = new Set();
  const resolve = (node) => (node && typeof node.$ref === 'string' ? defs[node.$ref.split('/').pop()] ?? node : node);
  const isOpen = (node) => {
    const ap = node.additionalProperties;
    if (ap === true) return true;
    if (ap && typeof ap === 'object' && Object.keys(ap).length === 0) return true;
    return node.type === 'object' && ap === undefined && !node.properties && !node.patternProperties;
  };
  const add = (p, node) => {
    const cur = out.get(p) ?? { types: new Set(), enum: new Set(), default: undefined, open: false };
    const t = node.type ?? (node.const !== undefined ? 'const' : undefined);
    for (const x of [t].flat().filter(Boolean)) cur.types.add(x);
    for (const e of node.enum ?? []) cur.enum.add(JSON.stringify(e));
    if (node.const !== undefined) cur.enum.add(JSON.stringify(node.const));
    if (node.default !== undefined) cur.default = JSON.stringify(node.default);
    if (isOpen(node)) cur.open = true;
    out.set(p, cur);
  };
  const walk = (raw, p, depth) => {
    const node = resolve(raw);
    if (!node || typeof node !== 'object' || depth > 40) return;
    const key = `${p}|${JSON.stringify(node).length}`;
    if (seen.has(key) && depth > 8) return;
    seen.add(key);
    add(p, node);
    for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) walk(alt, p, depth + 1);
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, p ? `${p}.${k}` : k, depth + 1);
    if (node.additionalProperties && typeof node.additionalProperties === 'object' && Object.keys(node.additionalProperties).length) walk(node.additionalProperties, `${p}.<key>`, depth + 1);
    for (const v of Object.values(node.patternProperties ?? {})) walk(v, `${p}.<key>`, depth + 1);
    if (node.items) for (const it of [node.items].flat()) walk(it, `${p}[]`, depth + 1);
  };
  walk(schema, '', 0);
  out.delete('');
  return out;
}

/**
 * How a schema accepts a config path: 'named' (every segment by name), 'map' (through a `<key>`
 * map), 'open' (under an object that accepts anything: present but unchecked; `at` says where) or
 * 'missing'. Config paths use `.` between keys and `[]` for array items.
 */
export function schemaLookup(map, p) {
  const segs = p.split('.');
  if (segs.length > 14) return { status: map.has(p) ? 'named' : 'missing' };
  let open = null;
  for (let mask = 0; mask < 1 << segs.length; mask++) {
    const alt = segs.map((s, i) => (mask & (1 << i) ? `<key>${s.match(/(\[\])*$/)[0]}` : s));
    const full = alt.join('.');
    if (map.has(full)) return { status: mask === 0 ? 'named' : 'map', at: full };
    if (!open) {
      for (let j = segs.length - 1; j > 0; j--) {
        const anc = alt.slice(0, j).join('.');
        const node = map.get(anc) ?? map.get(anc.replace(/(\[\])+$/, ''));
        if (node?.open) { open = { status: 'open', at: anc }; break; }
      }
    }
  }
  return open ?? { status: 'missing' };
}

/** True when the schema accepts the path by name or through a map (not only through an open node). */
export const schemaKnows = (map, p) => ['named', 'map'].includes(schemaLookup(map, p).status);

// ── The Rev4a API ───────────────────────────────────────────────────────────

/**
 * REV4A_TOKEN from the environment or the install's .env: the API's own Bearer credential.
 * (Since SEC-21 a session cookie must carry the password fingerprint; the Bearer path needs none.)
 */
function apiToken() {
  if (process.env.REV4A_TOKEN) return process.env.REV4A_TOKEN;
  // Same lookup as the server (lib/rev4a-paths.ts): REV4A_DATA_DIR first, then the default.
  const candidates = [
    process.env.REV4A_ENV_FILE,
    process.env.REV4A_DATA_DIR && path.join(process.env.REV4A_DATA_DIR, '.env'),
    path.join(os.homedir(), '.config', 'rev4a', '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const m = [...text.matchAll(/^\s*(?:export\s+)?REV4A_TOKEN\s*=([^\r\n]*)$/gm)].pop();
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new UsageError('REV4A_TOKEN not found: set it, or REV4A_ENV_FILE to the .env of the Rev4a instance under test');
}

/**
 * Call the local Rev4a API. Returns `{ status, text, json }`; never throws on HTTP errors.
 * `status` is -1 when no answer came (refused, timed out): never 0, which used to read like a
 * success exit status in the snapshot index. Calls time out after 120 s by default.
 */
export async function api(method, apiPath, body, { baseUrl = process.env.REV4A_BASE_URL || 'http://localhost:3740', timeoutMs = 120_000 } = {}) {
  const auth = `Bearer ${apiToken()}`;
  let res;
  try {
    res = await fetch(new URL(apiPath, baseUrl), {
      method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { status: -1, text: `no answer from ${baseUrl}: ${e.cause?.code ?? e.name ?? ''} ${e.message}`.trim(), json: undefined };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

// ── Agents ──────────────────────────────────────────────────────────────────

// A throwaway test agent: its Rev4a name (AGENT_NAME, what the Agents page shows) is `oc-eval`
// or starts with `oc-eval-`. seed.mjs and snapshot.mjs refuse any other agent unless
// --i-own-this-agent is passed: one wrong id in a long session would otherwise overwrite a real
// agent's Telegram channel with a fake token.
export const TEST_AGENT_NAME = /^oc-eval(-|$)/;

/** `docker inspect` of an agent, reduced to what the scripts need; null when there is no such container. */
export function inspectAgent(container) {
  const r = run('docker', ['inspect', container], { timeoutMs: 30_000 });
  if (r.missing) throw new UsageError('docker is not available on this host');
  if (r.rc !== 0) return null;
  const info = firstJson(r.stdout)?.[0];
  if (!info) return null;
  const env = Object.fromEntries((info.Config?.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const name = String(info.Name ?? '').replace(/^\//, '');
  return {
    name,
    agentId: info.Config?.Labels?.AGENT_ID ?? null,
    displayName: env.AGENT_NAME || name,
    image: info.Config?.Image,
    running: info.State?.Running === true,
    status: info.State?.Status,
    startedAt: info.State?.StartedAt,
    restarts: info.RestartCount,
    oomKilled: info.State?.OOMKilled,
    memoryLimit: info.HostConfig?.Memory,
  };
}

/** Throw unless the agent is a test agent or the caller said it owns it. */
export function assertTestAgent(agent, args) {
  if (TEST_AGENT_NAME.test(agent.displayName)) return;
  if (args['i-own-this-agent']) {
    console.error(`warning: ${agent.name} ("${agent.displayName}") is not named oc-eval-*; going on because of --i-own-this-agent`);
    return;
  }
  throw new UsageError(`${agent.name} is named "${agent.displayName}", not oc-eval-*: never seed or snapshot an agent someone uses. `
    + 'Create a test agent named oc-eval-<something>, or pass --i-own-this-agent if this one is really a throwaway.');
}


// ── Agent output helpers ────────────────────────────────────────────────────

/** The jobs of a `cron list` answer: Rev4a accepts a plain array or `{jobs[]}` (inventory J6). */
export const cronJobs = (v) => (Array.isArray(v) ? v : Array.isArray(v?.jobs) ? v.jobs : []);

// Docker's embedded DNS listens on 127.0.0.11 at a random port in every container on a user-defined network
// (rev4a-network). /proc/net/tcp writes the IPv4 address little-endian: 127.0.0.11 is 0B00007F.
const DOCKER_DNS_HEX = '0B00007F';

/** Listening TCP ports from /proc/net/tcp{,6} (state 0A), as numbers; Docker's embedded DNS is not OpenClaw's. */
export function listeningPorts(text) {
  const ports = new Set();
  for (const l of text.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length > 3 && f[3] === '0A' && /:[0-9A-F]{4}$/i.test(f[1]) && f[1].split(':')[0].toUpperCase() !== DOCKER_DNS_HEX) {
      ports.add(parseInt(f[1].split(':').pop(), 16));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Lines of a Gateway log without the Docker `-t` prefix and the Gateway's own ISO timestamp. */
export const stripStamps = (l) => l.replace(/^(\s*\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)?\s+)+/, '');

/** Whole OpenClaw doctor boxes (`◇  Doctor …` to the closing `╯`), not only their headers. */
export function doctorBoxes(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/◇\s+Doctor|Auto-migrated|Doctor (warnings|changes)/.test(lines[i])) continue;
    out.push(lines[i]);
    if (!/◇/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && j < i + 80; j++) {
      out.push(lines[j]);
      if (/╯/.test(lines[j])) { i = j; break; }
    }
    out.push('');
  }
  return out;
}

// ── Comparing shapes ────────────────────────────────────────────────────────

/** The parent of a shape path (`$.a.b` → `$.a`, `$.a[]` → `$.a`), or null for `$`. */
export function parentPath(p) {
  if (p === '$') return null;
  if (p.endsWith('[]')) return p.slice(0, -2);
  const i = p.lastIndexOf('.');
  return i > 0 ? p.slice(0, i) : '$';
}

const under = (p, root) => p === root || p.startsWith(`${root}.`) || p.startsWith(`${root}[]`);

/**
 * Differences between two shape maps (shapeMap). Rules that keep data from reading as schema:
 *   - `null` is merged into any other type: `string` in A and `null` in B is not a change;
 *   - a path missing on one side under a parent that is empty, null or a scalar there (an empty
 *     array, no paired device) is "not comparable", never "removed";
 *   - a type gained on a path already reported as retyped is not reported again as widened;
 *   - a removed or added subtree is reported once, at its shallowest path, with a count.
 */
export function diffShapes(mapA, mapB) {
  const parents = (m) => { const s = new Set(); for (const k of m.keys()) { const p = parentPath(k); if (p) s.add(p); } return s; };
  const pa = parents(mapA); const pb = parents(mapB);
  const concrete = (t) => [...(t ?? [])].filter((x) => x !== 'null').sort();
  const out = { removed: [], retyped: [], widened: [], added: [], notComparable: [] };
  const retypedPaths = [];
  for (const [p, ta] of mapA) {
    if (!mapB.has(p)) continue;
    const ca = concrete(ta); const cb = concrete(mapB.get(p));
    if (!ca.length || !cb.length) {
      if (ca.length !== cb.length) out.notComparable.push({ path: p, why: `null in ${ca.length ? 'B' : 'A'}` });
      continue;
    }
    const lost = ca.filter((t) => !cb.includes(t));
    const gained = cb.filter((t) => !ca.includes(t));
    if (lost.length) { out.retyped.push({ path: p, from: ca, to: cb }); retypedPaths.push(p); } else if (gained.length) out.widened.push({ path: p, from: ca, to: cb });
  }
  // One side only: walk up to the nearest path the other side has.
  const oneSide = (mine, other, otherParents, list, otherName) => {
    const roots = new Map();
    for (const p of mine.keys()) {
      if (other.has(p)) continue;
      let q = parentPath(p);
      while (q && !other.has(q)) q = parentPath(q);
      // Below a retyped path (object → string, say): the retype already says it.
      if (q && retypedPaths.some((r) => under(q, r))) continue;
      if (q && !otherParents.has(q)) { out.notComparable.push({ path: p, why: `empty, null or scalar in ${otherName} at ${q}` }); continue; }
      // The shallowest missing ancestor is the root of this subtree.
      let root = p;
      for (let r = parentPath(p); r && r !== q; r = parentPath(r)) root = r;
      const cur = roots.get(root) ?? { path: root, types: [...(mine.get(root) ?? [])].sort(), paths: 0 };
      cur.paths++;
      roots.set(root, cur);
    }
    list.push(...[...roots.values()].sort((x, y) => x.path.localeCompare(y.path)));
  };
  oneSide(mapA, mapB, pb, out.removed, 'B');
  oneSide(mapB, mapA, pa, out.added, 'A');
  return out;
}

/** True when a shape map has the JSON path (or anything below it). */
export function shapeHas(map, p) {
  if (!map) return false;
  if (map.has(p)) return true;
  for (const k of map.keys()) if (k.startsWith(`${p}.`) || k.startsWith(`${p}[]`)) return true;
  return false;
}

/**
 * The JSON fields Rev4a parses (deps.json `fields`) against shape maps of the after-snapshot (B)
 * and optionally the before-snapshot (A), by snapshot item. Status per field: 'present' in B;
 * 'lost' (in A, not in B: a probable defect); 'not-comparable' (in A; in B the array
 * above it is empty or the value null); 'absent' (in neither: not exercised);
 * 'optional-absent' (in neither, and Rev4a tolerates that); 'no-item' (the item failed or was
 * skipped in B, so nothing was checked).
 */
export function checkFields(fields, shapesB, shapesA = null) {
  // A field under an array that is empty (or a value that is null) in B holds no data there: not a loss.
  const emptyAbove = (m, p) => {
    let q = parentPath(p);
    while (q && !m.has(q)) q = parentPath(q);
    return !!q && q !== '$' && !shapeHas(new Map([...m].filter(([k]) => k !== q)), q);
  };
  const out = [];
  for (const f of fields) {
    const b = shapesB.get(f.item); const a = shapesA?.get(f.item);
    for (const spec of f.paths) {
      const alts = spec.split('|');
      let status;
      if (!b) status = 'no-item';
      else if (alts.some((p) => shapeHas(b, p))) status = 'present';
      else if (a && alts.some((p) => shapeHas(a, p))) status = alts.some((p) => emptyAbove(b, p)) ? 'not-comparable' : 'lost';
      else status = f.optional ? 'optional-absent' : 'absent';
      out.push({ id: f.id, item: f.item, path: spec, status, ...(f.needsSeed ? { needsSeed: f.needsSeed } : {}) });
    }
  }
  return out;
}

/** "1.871GiB / 3GiB" (docker stats) → { usedMb, limitMb }. */
export function parseMemUsage(s) {
  const mb = (t) => {
    const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(t ?? '');
    if (!m) return null;
    const f = { B: 1 / 1048576, KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024, TB: 1048576, TIB: 1048576 }[m[2].toUpperCase()];
    return f === undefined ? null : Math.round(Number(m[1]) * f);
  };
  const [u, l] = String(s ?? '').split('/');
  return { usedMb: mb(u), limitMb: mb(l) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The comparison's triage list ────────────────────────────────────────────

// Rev4a publishes one 10-port block from the Gateway port (lib/agent-ports.ts).
export const PORT_BLOCK = [3000, 3009];

/**
 * What a Rev4a API answer (as compare.mjs picks it) says went wrong: an `error`, or
 * `reachable: false` / `resolvable: false`, at the top or one level down. Null when nothing.
 */
export function apiProblem(value) {
  const look = (v, depth) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.error) return `error ${String(typeof v.error === 'string' ? v.error : JSON.stringify(v.error)).slice(0, 120)}`;
    if (v.reachable === false) return 'reachable: false';
    if (v.resolvable === false) return 'resolvable: false';
    if (depth > 0) for (const x of Object.values(v)) { const p = look(x, depth - 1); if (p) return p; }
    return null;
  };
  return look(value, 1);
}

/**
 * The triage list of a comparison: [{ level, text }], level `blocker-candidate` (probably breaks
 * Rev4a until explained), `read-first` (needs a decision) or `unverified` (nothing was compared).
 * Built from compare.json's facts alone, so compare.mjs (which writes it) and triage.mjs (T13,
 * which recomputes it) cannot drift apart. Every key may be missing: an older or hand-written
 * compare.json gives what it holds.
 */
export function compareTriage(f) {
  const triage = [];
  const T = (level, text) => triage.push({ level, text });
  const arr = (x) => (Array.isArray(x) ? x : []);
  if (f.update && f.update.status !== 'done') T('read-first', `Update status \`${f.update.status}\`${f.update.error ? `: ${f.update.error}` : ''}${f.update.verification ? ` (verification: ${JSON.stringify(f.update.verification).slice(0, 160)})` : ''}`);
  for (const x of arr(f.itemsChanged).filter((c) => c.b !== 'ok')) T('blocker-candidate', `\`${x.name}\` now fails: ${x.b}`);
  for (const x of arr(f.itemsFailingBoth)) T('unverified', `\`${x.name}\` failed in both snapshots, never verified: ${x.b ?? '?'}`);
  for (const x of arr(f.fields?.lost)) T('blocker-candidate', `${x.id}: \`${x.item}\` field \`${x.path}\` present in A, absent in B (Rev4a parses it)`);
  const lostKeys = new Set(arr(f.fields?.lost).flatMap((x) => String(x.path).split('|').map((p) => `${x.item} ${p}`)));
  for (const [item, d] of Object.entries(f.shape ?? {})) {
    for (const x of [...arr(d.removed), ...arr(d.retyped)].filter((y) => y.inventory && !lostKeys.has(`${item} ${y.path}`))) T('blocker-candidate', `${x.inventory.join(',')}: \`${item}\` \`${x.path}\` ${x.to ? `retyped ${arr(x.from).join('|')} → ${x.to.join('|')}` : 'removed'}`);
  }
  if (arr(f.cron?.owned?.gone).length) T('read-first', `OpenClaw-owned cron jobs gone: ${f.cron.owned.gone.join(', ')} (retired on purpose? check release-diff "retired")`);
  if (arr(f.cron?.user?.gone).length) T('blocker-candidate', `User cron jobs gone: ${f.cron.user.gone.join(', ')}`);
  for (const d of arr(f.dbVersions).filter((x) => x.oneWay)) T('read-first', `\`${d.file}\` user_version ${d.a} → ${d.b}: one-way, a rollback needs the pre-update backup`);
  for (const d of arr(f.dbVersions).filter((x) => x.gone)) T('blocker-candidate', `database \`${d.file}\` gone`);
  if (arr(f.tables?.gone).length) T('read-first', `Tables gone: ${f.tables.gone.join(', ')}`);
  if (arr(f.plugins?.gone).length) T('read-first', `Volume plugins gone or changed: ${f.plugins.gone.join(', ')} → ${arr(f.plugins.new).join(', ') || 'none'}`);
  if (arr(f.workspaceSkills?.gone).length) T('blocker-candidate', `Workspace skills gone: ${f.workspaceSkills.gone.join(', ')}`);
  const ma = f.memory?.a ?? {}; const mb = f.memory?.b ?? {};
  if (mb.restarts > (ma.restarts ?? 0) || mb.oomKilled) T('blocker-candidate', `Restarts ${ma.restarts} → ${mb.restarts}${mb.oomKilled ? ', OOMKilled' : ''}`);
  if (ma.usedMb && mb.usedMb && mb.usedMb > ma.usedMb * 1.15) T('read-first', `Memory ${ma.usedMb} → ${mb.usedMb} MB (+${Math.round((100 * mb.usedMb) / ma.usedMb) - 100}%)`);
  if (typeof mb.pct === 'number' && mb.pct >= 90) T('blocker-candidate', `Memory in B at ${mb.pct}% of the ${mb.limitMb ?? '?'} MB limit`);
  if (arr(f.agentDir?.staleInB).length) T('read-first', `${f.agentDir.staleInB.join(', ')} present in agents/*/agent on B: Sync All deletes them (inventory P8)`);
  if (arr(f.listeners?.outsideBlockB).length) T('blocker-candidate', `Listening outside ${PORT_BLOCK.join('-')}: ${f.listeners.outsideBlockB.join(', ')} (unpublished)`);
  if (arr(f.costsChanged).length) T('blocker-candidate', `Cost of days before the update changed: ${f.costsChanged.map((c) => `${c.date} ${c.a} → ${c.b}`).join(', ')}`);
  // A Rev4a answer that differs and, in B, reports an error or an unreachable/unresolvable model
  // (compare.mjs records `bProblem`; an older compare.json is read from its `b` text).
  for (const x of arr(f.api)) {
    let p = x.bProblem;
    if (p === undefined) { try { p = apiProblem(JSON.parse(x.b)); } catch { p = null; } }
    if (p) T('blocker-candidate', `\`${x.item}\` answers differently in B: ${p} (A: ${String(x.a).slice(0, 120)})`);
  }
  const doctor = arr(f.logs?.doctorB).filter((l) => /◇/.test(l)).length;
  if (doctor) T('read-first', `B's log has ${doctor} doctor box(es): read §4`);
  if (arr(f.logs?.newNotable).length) T('read-first', `${f.logs.newNotable.length} new notable log line(s) in B`);
  if (arr(f.fields?.absent).length) T('unverified', `${f.fields.absent.length} field(s) Rev4a parses are absent from both snapshots (not exercised): ${[...new Set(f.fields.absent.map((x) => x.id))].join(', ')}`);
  if (arr(f.notExercised).length) T('unverified', `${f.notExercised.length} item(s) empty or optional-failing on both sides: ${f.notExercised.map((x) => x.name).join(', ')}`);
  return triage;
}
