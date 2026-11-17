/**
 * Pure helpers for the Claude (Pro/Max) subscription, read through Claude Code inside the agent.
 *
 * Anthropic's sign-in happens in Anthropic's own flow: Claude Code opens its page, prints a link,
 * and waits for the code the operator pastes. Rev4a reads only the link and the outcome from that
 * output, hands the code to that one process and keeps nothing else — no token, no code, no
 * credential file is ever read. This module therefore never touches the network or a container:
 * every function is a pure transformation of text or of an agent's configuration, so the server
 * module, the routes and the tests share one behaviour.
 *
 * It has no imports at all (the tests load it directly), which is why the plan label is
 * capitalised here instead of importing `formatPlan` from lib/subscriptions-parse.js.
 */

/** The runtime OpenClaw uses to run `anthropic/*` models through Claude Code. */
export const CLAUDE_RUNTIME_ID = 'claude-cli';

/** The patch that switches every `anthropic/*` model of an agent to the Claude Code runtime. */
export const ROUTE_ON_PATCH: Readonly<Record<string, unknown>> = Object.freeze({
  agents: { defaults: { models: { 'anthropic/*': { agentRuntime: { id: CLAUDE_RUNTIME_ID } } } } },
});

/** The two hosts whose links Rev4a is willing to show. Anything else is dropped. */
const ALLOWED_URL_PREFIXES = [
  'https://claude.com/cai/oauth/authorize?',
  'https://claude.ai/oauth/authorize?',
] as const;

const MAX_URL_LENGTH = 2048;
const MAX_FAILED_LENGTH = 300;
const CODE_MIN_LENGTH = 8;
const CODE_MAX_LENGTH = 512;

export interface ClaudeLoginParse {
  /** Anthropic's own sign-in link, or null when the output names no link Rev4a may show. */
  url: string | null;
  /** The CLI printed its "Paste code here" prompt and is waiting for the code. */
  prompted: boolean;
  /** Anthropic's own failure sentence (after "Login failed:"), trimmed; null when it did not fail. */
  failed: string | null;
}

/** The states of a Claude login job, from the start to its final answer. */
export type ClaudeLoginState =
  | 'starting'
  | 'installing'
  | 'waiting'
  | 'verifying'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** What the job keeps of the sign-in output while it runs. */
export interface ClaudeLoginOutput {
  /** Raw output of the starting/installing/waiting stages; empty once a code was submitted. */
  output: string;
  /** Anthropic's failure sentence, the only thing kept once a code was submitted. */
  failed: string | null;
}

export interface ClaudeStatus {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  orgName: string | null;
  /** "Pro", "Max": capitalised from `subscriptionType` or `planTier`; null when unknown. */
  plan: string | null;
  /** ISO time the sign-in expires; null when Claude Code reports none. */
  expiresAt: string | null;
}

export type ClaudeState = 'not-installed' | 'signed-out' | 'route-off' | 'connected' | 'needs-reconnect';

export interface ClaudeStateInput {
  installed: boolean;
  status: ClaudeStatus | null;
  routeOn: boolean;
  /** Epoch ms, for the expiry check; defaults to now. */
  now?: number;
}

// ---- terminal output ---------------------------------------------------------------------

/** Remove colour and cursor sequences: the CLI draws a spinner and wraps the link in a hyperlink. */
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** An OSC 8 hyperlink: `ESC ] 8 ; ; <uri> BEL` or `ESC ] 8 ; ; <uri> ESC \`. */
const OSC8 = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** Any other operating-system command (title, notification). */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Strip ANSI escapes but keep line breaks, so a failure sentence can be read from its own line.
 * The link is both the visible text and the OSC 8 target; only the visible text is kept, and a
 * hyperlink that carries a target without visible text contributes nothing (an operator must see
 * the link they are asked to open).
 */
function cleanTerminal(text: string): string {
  return text.replace(CSI, '').replace(OSC8, '').replace(OSC, '');
}

/** A URL body: the characters a sign-in link from Anthropic uses, and no whitespace or control. */
const URL_BODY = /^[A-Za-z0-9\-._~%:/?#@!$&+,;=]+/;

/** The link at `at`, when it is one Rev4a may show; null otherwise. */
function linkAt(text: string, at: number): string | null {
  const rest = text.slice(at);
  const found = ALLOWED_URL_PREFIXES.find((prefix) => rest.startsWith(prefix));
  if (!found) return null;
  const body = URL_BODY.exec(rest.slice(found.length));
  const url = found + (body ? body[0] : '');
  // A link still arriving ends at the buffer's edge: wait for the character that closes it.
  const after = text.charAt(at + url.length);
  if (after && URL_BODY.test(after)) return null;
  if (!after && at + url.length >= text.length) return null;
  if (url.length > MAX_URL_LENGTH) return null;
  return url;
}

/**
 * Read the login output accumulated so far: Anthropic's link, whether the code prompt is shown,
 * and Anthropic's own failure sentence. A link from another host, an `http://` link or an
 * oversized one is null: Rev4a shows no link it does not recognise.
 */
export function parseClaudeLogin(text: unknown): ClaudeLoginParse {
  const raw = String(text ?? '');
  const flat = cleanTerminal(raw);

  let url: string | null = null;
  for (let i = flat.indexOf('https://'); i !== -1; i = flat.indexOf('https://', i + 1)) {
    url = linkAt(flat, i);
    if (url) break;
  }

  const prompted = /Paste code here/.test(flat);

  let failed: string | null = null;
  const marker = flat.indexOf('Login failed:');
  if (marker !== -1) {
    const rest = flat.slice(marker + 'Login failed:'.length);
    const end = rest.search(/[\r\n]/);
    // An unterminated OSC (a broken hyperlink) leaves its bytes on the line: drop every
    // control character, the escape introducer included, so the sentence is plain text.
    const line = (end === -1 ? rest : rest.slice(0, end)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (line) failed = line.slice(0, MAX_FAILED_LENGTH);
  }

  return { url, prompted, failed };
}

// ---- login job transitions ---------------------------------------------------------------

/**
 * The state after the install step finished: the job spawns the sign-in from `starting`, so
 * `onOutput` can move it to `waiting` when the link and the prompt appear.
 */
export function claudeLoginAfterInstall(state: ClaudeLoginState): ClaudeLoginState {
  return state === 'installing' ? 'starting' : state;
}

/** `starting` becomes `waiting` once the link is known and the code prompt was printed. */
export function claudeLoginOnPrompt(state: ClaudeLoginState, url: string | null, prompted: boolean): ClaudeLoginState {
  return state === 'starting' && url !== null && prompted ? 'waiting' : state;
}

/** The state a submitted code moves the job to, or null when the job does not accept one. */
export function claudeLoginSubmitState(state: ClaudeLoginState, codeSubmitted: boolean): 'verifying' | null {
  return state === 'waiting' && !codeSubmitted ? 'verifying' : null;
}

/**
 * Whether the 960 s job deadline may finish this state. `verifying` and `connecting` are bounded
 * by their own operation timeouts (the status read and the configuration patch), so a deadline
 * that fires there would report an expired code the agent accepted.
 */
export function claudeLoginDeadlineApplies(state: ClaudeLoginState): boolean {
  return state === 'starting' || state === 'installing' || state === 'waiting';
}

/**
 * What the job keeps of one output chunk. Before a code is submitted the raw output is needed to
 * read the link and the prompt; after it, the terminal echoes what was typed, so only the parsed
 * failure sentence is kept and the code never reaches a job field.
 */
export function claudeLoginOnOutput(
  state: ClaudeLoginState,
  stored: ClaudeLoginOutput,
  chunk: string,
): ClaudeLoginOutput {
  if (state === 'verifying' || state === 'connecting') {
    const p = parseClaudeLogin(chunk);
    return { output: '', failed: p.failed ?? stored.failed };
  }
  return { output: stored.output + chunk, failed: stored.failed };
}

/**
 * The code Claude Code asks for: 8 to 512 characters of `A-Z a-z 0-9 . _ ~ # + / = -`, with no
 * control character anywhere. The result goes to one process's stdin followed by a carriage
 * return, so a newline or another control character would feed it a second line: those are
 * refused instead of trimmed. Surrounding spaces are allowed and dropped.
 */
export function validClaudeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const code = value.replace(/^ +| +$/g, '');
  if (code.length < CODE_MIN_LENGTH || code.length > CODE_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9._~#+/=-]+$/.test(code)) return null;
  return code;
}

// ---- Claude Code status ------------------------------------------------------------------

/** JSON from output that may carry warnings before or after it. */
function extractJson(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  const s = String(input ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const parsed: unknown = JSON.parse(s.slice(a, b + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A label or address from the status output: a trimmed string without control characters. */
function text(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "pro" -> "Pro", "pro lite" -> "Pro Lite"; anything that is not a short word gives null. */
function planLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,23}$/.test(s)) return null;
  const words = s.split(/[\s_-]+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') || null;
}

/**
 * `claude auth status --json` → the fields Rev4a uses. Only `loggedIn`, `authMethod`, `email`,
 * `orgName`, `loginExpiresAt` and the plan fields survive: any other key an output ever carries
 * (a token, an organisation id, a path) is dropped here, so nothing past this function can leak
 * it. `plan` comes from `subscriptionType`, then `planTier` when the first is missing, empty or
 * unusable. null when the output is not JSON.
 */
export function parseClaudeStatus(stdout: unknown): ClaudeStatus | null {
  const json = extractJson(stdout);
  if (!json) return null;
  return {
    loggedIn: json.loggedIn === true,
    authMethod: text(json.authMethod, 40),
    email: text(json.email, 320),
    orgName: text(json.orgName, 200),
    plan: planLabel(json.subscriptionType) ?? planLabel(json.planTier),
    expiresAt: toIso(json.loginExpiresAt),
  };
}

// ---- agent configuration -----------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `agents.defaults.models` of an agent configuration, or null when it is not an object. */
function modelsOf(config: unknown): Record<string, unknown> | null {
  if (!isObject(config)) return null;
  const agents = config.agents;
  if (!isObject(agents)) return null;
  const defaults = agents.defaults;
  if (!isObject(defaults)) return null;
  return isObject(defaults.models) ? defaults.models : null;
}

/** Whether `anthropic/*` runs through Claude Code (`agentRuntime.id` is `claude-cli`). */
export function claudeRouteOn(config: unknown): boolean {
  const models = modelsOf(config);
  if (!models) return false;
  const entry = models['anthropic/*'];
  if (!isObject(entry)) return false;
  const runtime = entry.agentRuntime;
  return isObject(runtime) && runtime.id === CLAUDE_RUNTIME_ID;
}

/**
 * The patch that removes the Claude Code rule, or null when it is not there. `anthropic/*` is
 * sent as an explicit null so no other model rule changes; when it was the only key the whole
 * `models` object is nulled instead, so the configuration is exactly as it was before the rule
 * was written (OpenClaw would leave an empty `"models": {}` otherwise).
 */
export function routeRemovalPatch(config: unknown): Record<string, unknown> | null {
  if (!claudeRouteOn(config)) return null;
  const models = modelsOf(config);
  if (!models) return null;
  const patch = Object.keys(models).length === 1 && 'anthropic/*' in models
    ? { models: null }
    : { models: { 'anthropic/*': null } };
  return { agents: { defaults: patch } };
}

// ---- state -------------------------------------------------------------------------------

/**
 * The one state the page and the server agree on:
 * - not installed: Claude Code is missing from the agent;
 * - connected: signed in with a Claude plan through `claude.ai`, the `anthropic/*` rule is on and
 *   the sign-in has not expired;
 * - route-off: signed in, but the agent's `anthropic/*` models do not use Claude Code;
 * - needs-reconnect: the rule is on but Claude Code is signed out or its sign-in has expired;
 * - signed-out: nothing is signed in and nothing waits for it. A sign-in with another method
 *   (a Console/API account) is not a Claude plan, so it is signed-out too; the caller says why.
 */
export function claudeState(input: ClaudeStateInput): ClaudeState {
  if (!input.installed) return 'not-installed';
  const status = input.status;
  if (!status || !status.loggedIn || status.authMethod !== 'claude.ai') {
    return input.routeOn ? 'needs-reconnect' : 'signed-out';
  }
  if (status.expiresAt) {
    const expires = Date.parse(status.expiresAt);
    const now = input.now ?? Date.now();
    if (Number.isFinite(expires) && expires <= now) {
      return input.routeOn ? 'needs-reconnect' : 'signed-out';
    }
  }
  return input.routeOn ? 'connected' : 'route-off';
}

/** Everything one status read says about the row, before the caller adds the account fields. */
export interface ClaudeRowFactsInput extends ClaudeStateInput {
  /** `claude auth status` failed (a timeout, a non-JSON answer): the state could not be read. */
  statusError?: boolean;
  /** `openclaw.json` could not be read. */
  configError?: boolean;
}

export interface ClaudeRowFacts {
  state: ClaudeState;
  error: string | null;
  /**
   * Claude Code is signed in with an API (Console) account. Machine-readable, so the page never
   * parses `error`: that row offers Disconnect, to sign out and connect a Claude plan.
   */
  apiAccount: boolean;
}

/**
 * The state and the one error of a row. A status read that failed is never reported as "signed
 * out": the state still follows what the other facts say (so a route-on agent stays
 * needs-reconnect), but `error` says the sign-in state could not be read.
 */
export function describeClaudeFacts(input: ClaudeRowFactsInput): ClaudeRowFacts {
  const state = claudeState(input);
  if (input.installed && input.statusError) {
    return { state, error: "Could not read Claude Code's sign-in state", apiAccount: false };
  }
  if (input.installed && input.status?.loggedIn && input.status.authMethod !== 'claude.ai') {
    return { state, error: 'Claude Code is signed in with an API account, not a Claude plan.', apiAccount: true };
  }
  if (input.configError) {
    return { state, error: 'Could not read the agent configuration.', apiAccount: false };
  }
  return { state, error: null, apiAccount: false };
}

// ---- the in-container read ----------------------------------------------------------------

/**
 * The one in-container read, run as `docker exec <container> node -e CLAUDE_STATUS_SCRIPT_SRC`.
 * Fixed text: nothing is interpolated at run time, and the two paths are the agent's own.
 *
 * It checks the Claude Code binary, runs `claude --version` and `claude auth status --json` (each
 * under a 15 s timeout) and reads `agents.defaults.models` (reduced to each entry's runtime id)
 * and `agents.defaults.model` from `openclaw.json`, then prints ONE JSON line. Only whitelisted
 * fields are copied out: `claude auth status` holds no token, and any token a future version ever
 * adds is dropped here rather than carried through the exec. A config that cannot be read does not
 * fail the whole read: the other fields still print and `error` says `config`.
 *
 * It lives here, in the module with no imports, so a test can execute it against fixtures.
 */
export const CLAUDE_STATUS_SCRIPT_SRC = [
  "const fs=require('fs');",
  "const cp=require('child_process');",
  'const out={installed:false,version:null,status:null,statusError:false,models:null,model:null,error:null};',
  "const bin='/root/.local/bin/claude';",
  'const str=function(v){return typeof v==="string"?v:null;};',
  'try{',
  'if(fs.existsSync(bin)){',
  'out.installed=true;',
  "try{const v=cp.execFileSync(bin,['--version'],{encoding:'utf8',timeout:15000});out.version=(String(v).trim().slice(0,200))||null;}catch(e){}",
  "try{const r=cp.spawnSync(bin,['auth','status','--json'],{encoding:'utf8',timeout:15000});if(r.error)throw r.error;const raw=String(r.stdout||'');const a=raw.indexOf('{');const b=raw.lastIndexOf('}');if(a===-1||b<=a)throw new Error('no json');const s=JSON.parse(raw.slice(a,b+1));out.status={loggedIn:s&&s.loggedIn===true,authMethod:str(s&&s.authMethod),email:str(s&&s.email),orgName:str(s&&s.orgName),subscriptionType:str(s&&s.subscriptionType),planTier:str(s&&s.planTier),loginExpiresAt:str(s&&s.loginExpiresAt)};}catch(e){out.statusError=true;}",
  '}',
  '}catch(e){}',
  'try{',
  "const c=JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));",
  'const d=c&&c.agents&&c.agents.defaults;',
  'const m=d&&d.models;',
  "if(m&&typeof m==='object'&&!Array.isArray(m)){",
  'const picked={};',
  'const keys=Object.keys(m).slice(0,200);',
  'for(const k of keys){',
  'const v=m[k];',
  "picked[k]={agentRuntime:(v&&typeof v==='object'&&!Array.isArray(v)&&v.agentRuntime&&typeof v.agentRuntime==='object'&&typeof v.agentRuntime.id==='string')?{id:v.agentRuntime.id}:null};",
  '}',
  'out.models=picked;',
  '}',
  'const dm=d&&d.model;',
  "if(typeof dm==='string'){out.model={primary:dm,fallbacks:[]};}",
  "else if(dm&&typeof dm==='object'&&!Array.isArray(dm)){out.model={primary:typeof dm.primary==='string'?dm.primary:null,fallbacks:Array.isArray(dm.fallbacks)?dm.fallbacks.filter(function(f){return typeof f==='string'}):[]};}",
  'else{out.model={primary:null,fallbacks:[]};}',
  "}catch(e){out.error='config';}",
  'console.log(JSON.stringify(out));',
].join('\n');

// ---- usage limits --------------------------------------------------------------------------

/** One usage window, in the shape the ChatGPT usage already has (labels `windowShort` understands). */
export interface ClaudeUsageWindow {
  label: string;
  /** 0 to 100, rounded. */
  usedPercent: number;
  /** ISO time the window resets, or null when Claude Code gave none. */
  resetAt: string | null;
}

export const CLAUDE_TERMS_MESSAGE = 'Anthropic asks this account to accept its updated terms before Claude can answer. Sign in at claude.ai with this account and accept them.';

/** Detect only Anthropic's terms notice; other action-required notices stay ordinary failures. */
export function claudeTermsRequired(text: unknown): boolean {
  return typeof text === 'string' && /\[ACTION REQUIRED\]/i.test(text)
    && /Consumer Terms|review the updated terms/i.test(text);
}

/**
 * The fixed probe that makes Claude Code report the plan's usage: one tiny call (measured live
 * 2026-11-14: about 1.5 s and a few hundred tokens of the plan; Haiku, no tools, no session) whose stream carries a single `rate_limit_event`. It is a
 * fixed string with no input in it; it reads no credential file and keeps no session. It ends in
 * `; true`: a call refused at the plan's limit exits non-zero but still prints the event that says
 * so, and the parsed event (not the exit code) decides; a timeout leaves no event and stays a failure.
 */
export const CLAUDE_USAGE_PROBE =
  'cd /tmp && timeout 60 /root/.local/bin/claude -p "." --model haiku --system-prompt "Answer with one character." '
  + '--tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --output-format stream-json --verbose 2>&1; true';

/** The windows Claude Code reports, with the labels the ChatGPT usage uses for the same windows. */
const CLAUDE_USAGE_WINDOWS: readonly (readonly [string, string])[] = [
  ['five_hour', '5 hours'],
  ['seven_day', 'Week'],
];

/**
 * The usage windows from the combined stdout/stderr of the probe: only the `rate_limit_event` line is read (every
 * other line, and every other field of that line, is ignored). `utilization` is a 0..1 fraction
 * and `resetsAt` epoch seconds. A window with no finite utilization is left out; null when there
 * is no event, nothing usable in it, or the text is not stream-json at all.
 */
export function parseClaudeUsageEvent(stdout: unknown): ClaudeUsageWindow[] | null {
  if (typeof stdout !== 'string') return null;
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{') || !text.includes('rate_limit_event')) continue;
    let event: unknown;
    try { event = JSON.parse(text); } catch { continue; }
    if (!isUsageRecord(event) || event.type !== 'rate_limit_event') continue;
    const info = event.rate_limit_info;
    const windows = isUsageRecord(info) && isUsageRecord(info.unifiedWindows) ? info.unifiedWindows : null;
    if (!windows) continue;
    const out: ClaudeUsageWindow[] = [];
    for (const [key, label] of CLAUDE_USAGE_WINDOWS) {
      const w = Object.prototype.hasOwnProperty.call(windows, key) ? windows[key] : null;
      if (!isUsageRecord(w) || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
      // Epoch seconds; a value that only makes sense as milliseconds (or worse) is not a reset time.
      const seconds = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt > 0 && w.resetsAt < 1e11 ? new Date(w.resetsAt * 1000) : null;
      out.push({
        label,
        usedPercent: Math.max(0, Math.min(100, Math.round(w.utilization * 100))),
        resetAt: seconds && !Number.isNaN(seconds.getTime()) ? seconds.toISOString() : null,
      });
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
