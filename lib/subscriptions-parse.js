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

/** `openclaw models auth list --provider openai --json` → profiles. null when the output is not usable. */
function parseAuthList(input) {
  const json = extractJson(input);
  if (!json || !Array.isArray(json.profiles)) return null;
  return json.profiles
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
    .map((p) => ({
      id: p.id,
      type: typeof p.type === 'string' ? p.type : null,
      email: typeof p.email === 'string' ? p.email : null,
      expiresAt: toIso(p.expiresAt),
    }));
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
 * null when the output is not usable; `legacy: true` when the agent has another layout.
 */
function parseStatusJson(input) {
  const json = extractJson(input);
  if (!json || typeof json !== 'object') return null;
  if (json.legacy === true) return { legacy: true, profiles: [], model: null, error: null };
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
  return { legacy: false, profiles, model, error: typeof json.error === 'string' ? json.error : null };
}

/**
 * One entry of the agent's auth profile store as the status read reports it. SELF-CONTAINED on
 * purpose: lib/subscriptions.ts embeds its source (Function#toString) in the script that runs
 * inside the agent, so it may use nothing from this module. The tokens are never copied, a date
 * that is not a real instant gives null (toISOString would throw and turn the whole read into
 * "legacy"), and a text field is emitted only when it is a string.
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

const isSubscriptionModel = (id) => typeof id === 'string' && id.startsWith(SUBSCRIPTION_PREFIX);
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
 * (through mapStoreProfile: never the tokens) and the model, or {"legacy":true} for another layout.
 * The paths are fixed; scripts/test-subscriptions.mjs runs it against fixtures by substituting them.
 */
const STATUS_SCRIPT_SRC = [
  "const fs=require('fs');",
  'const mapStoreProfile=(' + MAP_STORE_PROFILE_SRC + ');',
  'const out={profiles:[],model:null};',
  'let legacy=false;',
  'try{',
  "const {DatabaseSync}=require('node:sqlite');",
  "const file='/root/.openclaw/state/openclaw.sqlite';",
  'if(!fs.existsSync(file)){legacy=true}else{',
  'const db=new DatabaseSync(file,{readOnly:true});',
  'try{',
  `const row=db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'").get();`,
  'if(row&&row.value_json){',
  'const store=JSON.parse(row.value_json);',
  'const p=(store&&store.profiles)||{};',
  'for(const id of Object.keys(p)){',
  'out.profiles.push(mapStoreProfile(id,p[id]));',
  '}}',
  '}finally{db.close()}',
  '}',
  '}catch(e){legacy=true}',
  "if(legacy){console.log(JSON.stringify({legacy:true}));process.exit(0)}",
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

module.exports = {
  parseUsageStatus,
  SUBSCRIPTION_PREFIX,
  cleanTerminalText,
  parseDeviceLogin,
  parseAuthList,
  parseModelList,
  parseStatusJson,
  mapStoreProfile,
  MAP_STORE_PROFILE_SRC,
  STATUS_SCRIPT_SRC,
  formatPlan,
  stopSubscriptionModel,
  isSubscriptionModel,
  normalizeModel,
};
