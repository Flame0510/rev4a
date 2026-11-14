/**
 * Pure helpers for the Subscriptions feature: parsing what the OpenClaw CLI prints and
 * rewriting an agent's `agents.defaults.model`. CommonJS with a sibling `.d.ts` so the
 * server code, the test script and the packed npm tarball all load the same file.
 */

const SUBSCRIPTION_PREFIX = 'openai/';

/** Remove ANSI sequences and every line break: the CLI redraws a spinner and may print one character per line. */
function cleanTerminalText(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\r\n]/g, '');
}

/**
 * Read the device-code login output accumulated so far.
 * `done` is 'ok' once OpenAI confirmed, 'failed' on a failure or timeout, null while it runs.
 *
 * The code is 4 characters, a dash and 5 characters (`LBVC-84CXA`). It is accepted only when it
 * comes after the link and another character follows it in the buffer, so a code that is still
 * arriving (one character at a time, or split across chunks) is never taken half-read, and a
 * code-shaped token in an earlier warning (`UTF8-12345`) is ignored.
 */
function parseDeviceLogin(text) {
  const flat = cleanTerminalText(text);
  const urlMatch = flat.match(/https:\/\/auth\.openai\.com\/codex\/device/);
  const url = urlMatch ? urlMatch[0] : null;

  let code = null;
  if (urlMatch) {
    const after = flat.slice(flat.indexOf(urlMatch[0]) + urlMatch[0].length);
    const m = after.match(/(?<![A-Za-z0-9])([A-Z0-9]{4}-[A-Z0-9]{5})(?=[\s\S])/);
    if (m) code = m[1];
  }

  const exp = flat.match(/expires in (\d+) minutes?/i);
  const expiresInMin = exp ? Number(exp[1]) : null;

  let done = null;
  let error = null;
  if (/OpenAI device code complete/i.test(flat)) {
    done = 'ok';
  } else if (/OpenAI device code failed/i.test(flat)) {
    done = 'failed';
    error = 'OpenAI could not complete the login. Start it again for a new code.';
  } else if (/timed out/i.test(flat)) {
    done = 'failed';
    error = 'The login timed out before the code was entered. Start it again for a new code.';
  }
  return { url, code, expiresInMin, done, error };
}

/** JSON from CLI output that may carry warnings before or after it. */
function extractJson(input) {
  if (input && typeof input === 'object') return input;
  const s = String(input ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

function toIso(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `openclaw models list --provider openai --json` → models. null when the output is not usable. */
function parseModelList(input) {
  const json = extractJson(input);
  if (!json || !Array.isArray(json.models)) return null;
  return json.models
    .filter((m) => m && typeof m === 'object' && typeof m.key === 'string')
    .map((m) => ({
      key: m.key,
      name: typeof m.name === 'string' ? m.name : m.key,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    }));
}

/** "plus" -> "Plus"; anything that is not a short word is dropped (unknown -> null). */
function formatPlan(plan) {
  if (typeof plan !== 'string') return null;
  const s = plan.trim();
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,23}$/.test(s)) return null;
  const words = s.split(/[\s_-]+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') || null;
}

/**
 * The one JSON line printed by the in-container status script (lib/subscriptions.ts).
 * Only the whitelisted fields survive: a token (`access`, `refresh`), an `accountId` or any
 * other key that ever arrives is dropped here, so nothing past this function can leak it.
 * null when the output is not usable; `unsupported: true` when the agent does not keep its state where 2026.9.x does.
 */
function parseStatusJson(input) {
  const json = extractJson(input);
  if (!json || typeof json !== 'object') return null;
  if (json.unsupported === true) return { unsupported: true, profiles: [], model: null, error: null };
  const profiles = (Array.isArray(json.profiles) ? json.profiles : [])
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
    .map((p) => ({
      id: p.id,
      type: typeof p.type === 'string' ? p.type : null,
      provider: typeof p.provider === 'string' ? p.provider : null,
      email: typeof p.email === 'string' ? p.email : null,
      expiresAt: toIso(p.expiresAt),
      plan: formatPlan(p.plan),
    }));
  let model = null;
  if (json.model && typeof json.model === 'object') {
    model = {
      primary: typeof json.model.primary === 'string' ? json.model.primary : null,
      fallbacks: Array.isArray(json.model.fallbacks) ? json.model.fallbacks.filter((f) => typeof f === 'string') : [],
    };
  }
  return { unsupported: false, profiles, model, error: typeof json.error === 'string' ? json.error : null };
}

/** Read-only ChatGPT OAuth references for explicit automation adoption; never choose an account. */
function subscriptionProfileReferences(profiles) {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .filter((profile) => profile && typeof profile === 'object' && !Array.isArray(profile)
      && typeof profile.id === 'string' && profile.id.startsWith('openai:') && profile.id.length > 'openai:'.length
      && !/[\u0000-\u001f\u007f]/.test(profile.id) && profile.type === 'oauth'
      && (profile.provider == null || profile.provider === 'openai'))
    .map((profile) => ({
      id: profile.id,
      email: typeof profile.email === 'string' ? profile.email : null,
      plan: formatPlan(profile.plan),
      expiresAt: toIso(profile.expiresAt),
    }));
}

/**
 * One entry of the agent's auth profile store as the status read reports it. SELF-CONTAINED on
 * purpose: lib/subscriptions.ts embeds its source (Function#toString) in the script that runs
 * inside the agent, so it may use nothing from this module. The tokens are never copied, a date
 * that is not a real instant gives null (toISOString would throw and turn the whole read into
 * a failed read), and a text field is emitted only when it is a string.
 */
/**
 * Kept as source text: the same text is evaluated here (for tests) and embedded in the
 * in-container STATUS_SCRIPT. Function.prototype.toString cannot be used for that: after the
 * Next.js build it returns the bundler's minified code, which does not run on its own.
 */
const MAP_STORE_PROFILE_SRC =
  "function(id, x) { x = x && typeof x === 'object' ? x : {}; var str = function (v) { return typeof v === 'string' ? v : null; }; var iso = null; if (typeof x.expires === 'number' && isFinite(x.expires) && Math.abs(x.expires) <= 8.64e15) { var d = new Date(x.expires); var y = d.getUTCFullYear(); if (y >= 1970 && y <= 9999) iso = d.toISOString(); } return { id: id, type: str(x.type), provider: str(x.provider), email: str(x.email), expiresAt: iso, plan: str(x.chatgptPlanType) }; }";
// eslint-disable-next-line no-new-func
const mapStoreProfile = new Function('return (' + MAP_STORE_PROFILE_SRC + ');')();

function normalizeModel(model) {
  if (typeof model === 'string') return { primary: model, fallbacks: [] };
  if (model && typeof model === 'object') {
    return {
      primary: typeof model.primary === 'string' ? model.primary : null,
      fallbacks: Array.isArray(model.fallbacks) ? model.fallbacks.filter((f) => typeof f === 'string') : [],
    };
  }
  return { primary: null, fallbacks: [] };
}

/**
 * Whether a model id is a bare subscription model of `prefix` (`openai/` by default, `anthropic/`
 * for Claude). A Rev4a proxy model (`rev4a/openai/…`) is never one: it carries the proxy prefix.
 */
const isSubscriptionModel = (id, prefix = SUBSCRIPTION_PREFIX) => typeof id === 'string' && id.startsWith(prefix);
const dedupe = (arr) => [...new Set(arr)];

/**
 * The reverse: the first non-subscription fallback becomes the primary. Unchanged when the
 * primary is not a subscription model, or when there is no fallback to go back to.
 */
function stopSubscriptionModel(model) {
  const cur = normalizeModel(model);
  if (!isSubscriptionModel(cur.primary)) return model;
  const next = cur.fallbacks.find((f) => !isSubscriptionModel(f));
  if (!next) return model;
  const i = cur.fallbacks.indexOf(next);
  const fallbacks = dedupe(cur.fallbacks.filter((_, j) => j !== i));
  return { primary: next, fallbacks };
}

/**
 * The in-container status read (run as `docker exec <c> node -e STATUS_SCRIPT_SRC`): opens the
 * agent's state database read-only and its openclaw.json, prints one JSON line with the profiles
 * (through mapStoreProfile: never the tokens) and the model, or {"unsupported":true} when the state is not where 2026.9.x keeps it
 * (no node:sqlite, no state database, no profile table). Any other failure exits 1 and prints
 * ONE fixed category to stderr (never the raw exception, which can quote the stored value):
 * "state database locked", "state database unreadable" or "profile store unreadable".
 * The paths are fixed; scripts/test-subscriptions.mjs runs it against fixtures by substituting them.
 */
const STATUS_SCRIPT_SRC = [
  "const fs=require('fs');",
  'const mapStoreProfile=(' + MAP_STORE_PROFILE_SRC + ');',
  'const out={profiles:[],model:null};',
  'let unsupported=false;',
  "let stage='db';",
  'try{',
  "const {DatabaseSync}=require('node:sqlite');",
  "const file='/root/.openclaw/state/openclaw.sqlite';",
  'if(!fs.existsSync(file)){unsupported=true}else{',
  'const db=new DatabaseSync(file,{readOnly:true});',
  'try{',
  'let row;',
  'try{',
  `row=db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'").get();`,
  '}catch(e){if(/no such table/i.test(String(e&&e.message))){unsupported=true}else{throw e}}',
  'if(row&&row.value_json){',
  "stage='parse';",
  'const store=JSON.parse(row.value_json);',
  'const p=(store&&store.profiles)||{};',
  'for(const id of Object.keys(p)){',
  'out.profiles.push(mapStoreProfile(id,p[id]));',
  '}}',
  '}finally{db.close()}',
  '}',
  "}catch(e){if(e&&(e.code==='ERR_UNKNOWN_BUILTIN_MODULE'||e.code==='MODULE_NOT_FOUND')){unsupported=true}else{const m=String(e&&e.message);console.error(/locked|busy/i.test(m)?'state database locked':stage==='parse'?'profile store unreadable':'state database unreadable');process.exit(1)}}",
  "if(unsupported){console.log(JSON.stringify({unsupported:true}));process.exit(0)}",
  'try{',
  "const c=JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));",
  'const m=c&&c.agents&&c.agents.defaults&&c.agents.defaults.model;',
  "if(typeof m==='string'){out.model={primary:m,fallbacks:[]}}",
  "else if(m&&typeof m==='object'){out.model={primary:typeof m.primary==='string'?m.primary:null,fallbacks:Array.isArray(m.fallbacks)?m.fallbacks.filter(function(f){return typeof f==='string'}):[]}}",
  'else{out.model={primary:null,fallbacks:[]}}',
  "}catch(e){out.error='config'}",
  'console.log(JSON.stringify(out));',
].join('\n');

/**
 * `openclaw status --usage --json` → the ChatGPT (Codex) quota windows, per account.
 * Only the `openai` provider is read, and only email, plan, window label, percent and reset
 * time are copied. Tolerant of lines before the JSON, missing fields and bad numbers.
 */
function parseUsageStatus(text) {
  const json = extractJson(text);
  const usage = json && typeof json === 'object' ? json.usage : null;
  const providers = usage && Array.isArray(usage.providers) ? usage.providers : [];
  const updatedAt = toIso(usage && usage.updatedAt);
  const accounts = [];
  for (const p of providers) {
    if (!p || typeof p !== 'object' || p.provider !== 'openai') continue;
    const windows = (Array.isArray(p.windows) ? p.windows : [])
      .filter((w) => w && typeof w === 'object' && typeof w.label === 'string' && w.label.trim())
      .map((w) => {
        const n = Number(w.usedPercent);
        return {
          label: w.label.trim().slice(0, 40),
          usedPercent: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0,
          resetAt: toIso(w.resetAt),
        };
      });
    accounts.push({
      email: typeof p.accountEmail === 'string' && p.accountEmail.trim() ? p.accountEmail.trim().slice(0, 200) : null,
      plan: formatPlan(p.plan),
      windows,
      updatedAt,
    });
  }
  return { accounts };
}

/** Seconds a login may run: the in-container `timeout`, the readiness wait before it and a tail. */
const LOGIN_TIMEOUT_S = 900;
const LOGIN_READY_S = 60;
const LOGIN_TAIL_S = 60;
const LOGIN_DEADLINE_S = LOGIN_TIMEOUT_S + LOGIN_READY_S + LOGIN_TAIL_S;

/** Epoch ms after which a login job that has not finished counts as expired (its agent stops being busy). */
function loginDeadlineAt(startedAt) {
  return startedAt + LOGIN_DEADLINE_S * 1000;
}

/** Whether a usage cache entry (`{ at }`, a read or a failed read) answers a request, or the CLI must run. */
function usageCacheAction(entry, now, refresh, ttlMs) {
  if (refresh || !entry || typeof entry.at !== 'number') return 'read';
  return now - entry.at < ttlMs ? 'use' : 'read';
}

/**
 * The chip the agents list shows for a subscription primary: with no fallback it goes silent at
 * the usage limit, so the warning wins; with fallbacks the neutral subscription chip.
 * null when the primary is not a subscription model.
 */
function subscriptionChip(primary, fallbackCount) {
  if (!isSubscriptionModel(primary)) return null;
  // No chip for a subscription model as such (the model text says "· ChatGPT"): only the warning.
  return fallbackCount === 0 ? 'NO FALLBACK' : null;
}

/**
 * Plan the disconnect of one model entry: a subscription primary is replaced by the first own
 * fallback (or `homePrimary`), subscription fallbacks are dropped. `stuck` when a subscription
 * primary has nothing to go back to. `prefix` selects the provider (`openai/` by default).
 */
function revertSubscriptionModel(model, homePrimary, prefix = SUBSCRIPTION_PREFIX) {
  const n = normalizeModel(model);
  let primary = n.primary;
  let rest = n.fallbacks;
  if (isSubscriptionModel(primary, prefix)) {
    const next = n.fallbacks.find((f) => !isSubscriptionModel(f, prefix)) || (homePrimary && !isSubscriptionModel(homePrimary, prefix) ? homePrimary : null);
    if (!next) return { stuck: true, changed: false, primary, fallbacks: n.fallbacks };
    primary = next;
    rest = n.fallbacks.filter((f) => f !== next);
  }
  // Only an entry that holds a subscription model is rewritten: duplicates alone are left as they are.
  if (!isSubscriptionModel(n.primary, prefix) && !n.fallbacks.some((f) => isSubscriptionModel(f, prefix))) {
    return { stuck: false, changed: false, primary: n.primary, fallbacks: n.fallbacks };
  }
  const fallbacks = dedupe(rest.filter((f) => !isSubscriptionModel(f, prefix) && f !== primary));
  return { stuck: false, changed: true, primary, fallbacks };
}

/**
 * A fallback already stored on an agent, kept for a save that sent none: a bare `openai/<id>`
 * (a ChatGPT subscription model) and a `rev4a/` ref pass unchanged, anything else gets the prefix.
 */
function keepStoredRef(id) {
  if (typeof id !== 'string') return id;
  if (isSubscriptionModel(id) || id.startsWith('rev4a/')) return id;
  return 'rev4a/' + id;
}

/**
 * Stops the agent's Codex runtime: OpenClaw runs the ChatGPT models through the Codex app-server
 * (installed on first use under ~/.openclaw/npm/projects/openclaw-codex-*), and the gateway keeps it
 * running after a sign-out. Verified on OpenClaw 2026.9.3 (2026-10-09): after the processes are
 * ended the gateway stays healthy and the next subscription turn starts a new app-server by itself.
 * Fixed text (run as `docker exec <c> sh -c STOP_CODEX_SCRIPT`); it skips its own shell.
 */
const STOP_CODEX_SCRIPT =
  'exec 2>/dev/null; for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; ' +
  'c=$(tr "\\0" " " < "$p/cmdline"); case "$c" in ' +
  '*/openclaw-codex-*/node_modules/@openai/codex*) kill "${p#/proc/}";; esac; done; true';

/**
 * The reason shown for a failed status read, from the text of the exec failure. Only fixed
 * categories come out (never the raw stderr): the three the status script prints, "timed out",
 * "the container is not running", or a generic line.
 */
function statusFailureReason(message) {
  const m = String(message ?? '');
  const cat = m.match(/state database locked|state database unreadable|profile store unreadable/);
  if (cat) return cat[0];
  if (/timed out/i.test(m)) return 'timed out';
  if (/is not running|no such container/i.test(m)) return 'the container is not running';
  return 'the read failed';
}

/**
 * Retry policy for a status read: only a 'failed' answer is retried (never 'ok' or 'unsupported'),
 * after each pause in `delaysMs`; a timeout is retried once at most and a stopped container never,
 * so a hang does not become a long wait. `read` returns { status, reason? }.
 */
async function readWithRetry(read, delaysMs, sleep) {
  let r = await read();
  let timeouts = 0;
  for (const d of delaysMs) {
    if (r.status !== 'failed') return r;
    if (/not running/.test(r.reason)) return r;
    if (/timed out/.test(r.reason) && ++timeouts > 1) return r;
    await sleep(d);
    r = await read();
  }
  return r;
}

/** "2026.9.4" to "2026.9"; null when the text does not start with two numbers. */
function majorMinor(version) {
  const m = /^(\d+)\.(\d+)(?:\.|$|-)/.exec(String(version ?? '').trim().replace(/^v/i, ''));
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/** True when `version` is on the same major.minor line as one of the `supported` versions (any 2026.9.x build is the 2026.9 line). */
function isSupportedLine(version, supported) {
  const line = majorMinor(version);
  return line !== null && Array.isArray(supported) && supported.some((v) => majorMinor(v) === line);
}

module.exports = {
  majorMinor,
  isSupportedLine,
  statusFailureReason,
  readWithRetry,
  STOP_CODEX_SCRIPT,
  LOGIN_DEADLINE_S,
  loginDeadlineAt,
  usageCacheAction,
  subscriptionChip,
  revertSubscriptionModel,
  keepStoredRef,
  parseUsageStatus,
  SUBSCRIPTION_PREFIX,
  cleanTerminalText,
  parseDeviceLogin,
  parseModelList,
  parseStatusJson,
  subscriptionProfileReferences,
  mapStoreProfile,
  MAP_STORE_PROFILE_SRC,
  STATUS_SCRIPT_SRC,
  formatPlan,
  stopSubscriptionModel,
  isSubscriptionModel,
  normalizeModel,
};
