/**
 * Tests of the pure Subscriptions helpers (lib/subscriptions-parse.js).
 * Run: node scripts/test-subscriptions.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseDeviceLogin, parseAuthList, parseModelList, stopSubscriptionModel,
  parseStatusJson, parseUsageStatus, formatPlan, mapStoreProfile, STATUS_SCRIPT_SRC,
  loginDeadlineAt, LOGIN_DEADLINE_S, usageCacheAction, subscriptionChip, revertSubscriptionModel, keepStoredRef, STOP_CODEX_SCRIPT,
} = require('../lib/subscriptions-parse.js');
const { execFileSync } = require('node:child_process');
const fsx = require('node:fs');
const os = require('node:os');
const pathx = require('node:path');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

const ESC = '\x1b';
const URL_ = 'https://auth.openai.com/codex/device';

// ---- parseDeviceLogin ----------------------------------------------------------------

test('device login: waiting output with ANSI and a spinner', () => {
  const raw = [
    `${ESC}[?25l${ESC}[2K${ESC}[1G| Requesting device code\r\n`,
    `${ESC}[2K${ESC}[1GOpen ${ESC}[36m${URL_}${ESC}[39m\r\n`,
    `Enter code: ${ESC}[1mABCD-EFGH5${ESC}[22m\r\n`,
    `Code expires in 15 minutes.\r\n`,
    `${ESC}]0;title\x07${ESC}[2K/ Waiting for approval\r`,
  ].join('');
  const p = parseDeviceLogin(raw);
  assert.equal(p.url, URL_);
  assert.equal(p.code, 'ABCD-EFGH5');
  assert.equal(p.expiresInMin, 15);
  assert.equal(p.done, null);
  assert.equal(p.error, null);
});

test('device login: one character per line', () => {
  const text = `${URL_}\nCode: K7QZ-4M9P2\nexpires in 15 minutes`;
  const raw = [...text].join('\r\n') + '\r\n';
  const p = parseDeviceLogin(raw);
  assert.equal(p.url, URL_);
  assert.equal(p.code, 'K7QZ-4M9P2');
  assert.equal(p.expiresInMin, 15);
  assert.equal(p.done, null);
});

/** What onOutput does: feed the accumulated text after each piece, remember the first code ever accepted. */
function firstAcceptedCode(pieces) {
  let acc = '';
  let first = null;
  for (const piece of pieces) {
    acc += piece;
    const p = parseDeviceLogin(acc);
    if (p.code && !first) first = p.code;
  }
  return first;
}

test('device login: a code arriving one character at a time is never frozen half-read', () => {
  const text = `${URL_}\nCode: LBVC-84CXA\nCode expires in 15 minutes\n`;
  assert.equal(firstAcceptedCode([...text]), 'LBVC-84CXA');
  assert.equal(firstAcceptedCode([...text.replace(/\n/g, '\r\n')]), 'LBVC-84CXA');
});

test('device login: a code split across two chunks mid-code', () => {
  const text = `${URL_}\nCode: LBVC-84CXA\nCode expires in 15 minutes\n`;
  for (let cut = text.indexOf('LBVC'); cut < text.length; cut++) {
    assert.equal(firstAcceptedCode([text.slice(0, cut), text.slice(cut)]), 'LBVC-84CXA', `cut at ${cut}`);
  }
});

test('device login: a code at the very end of the buffer is not accepted yet', () => {
  assert.equal(parseDeviceLogin(`${URL_}\nCode: LBVC-84CXA`).code, null);
  assert.equal(parseDeviceLogin(`${URL_}\nCode: LBVC-84CX`).code, null);
});

test('device login: a code-shaped token in a warning before the link is ignored', () => {
  const text = `warning UTF8-12345 ignored\n${URL_}\nCode: LBVC-84CXA\nCode expires in 15 minutes\n`;
  assert.equal(firstAcceptedCode([...text]), 'LBVC-84CXA');
  assert.equal(parseDeviceLogin(`UTF8-12345\n${URL_}\n`).code, null);
});

test('device login: nothing yet', () => {
  const p = parseDeviceLogin('Starting...\r\n');
  assert.deepEqual(p, { url: null, code: null, expiresInMin: null, done: null, error: null });
});

test('device login: success', () => {
  const p = parseDeviceLogin(`${URL_}\r\nABCD-EFGH\r\n${ESC}[32mOpenAI device code complete${ESC}[39m\r\n`);
  assert.equal(p.done, 'ok');
  assert.equal(p.error, null);
});

test('device login: failure', () => {
  const p = parseDeviceLogin(`${URL_}\r\nABCD-EFGH\r\nOpenAI device code failed\r\n`);
  assert.equal(p.done, 'failed');
  assert.match(p.error, /could not complete/);
});

test('device login: timeout', () => {
  const p = parseDeviceLogin(`${URL_}\r\nABCD-EFGH\r\nDevice code timed out\r\n`);
  assert.equal(p.done, 'failed');
  assert.match(p.error, /timed out/);
});

// ---- parseAuthList / parseModelList --------------------------------------------------

test('auth list: one oauth profile', () => {
  const out = JSON.stringify({ profiles: [{ id: 'openai:me@example.com', type: 'oauth', email: 'me@example.com', expiresAt: '2026-10-18T10:00:00.000Z' }] });
  assert.deepEqual(parseAuthList(out), [
    { id: 'openai:me@example.com', type: 'oauth', email: 'me@example.com', expiresAt: '2026-10-18T10:00:00.000Z' },
  ]);
});

test('auth list: empty, warnings around the JSON, and garbage', () => {
  assert.deepEqual(parseAuthList('{"profiles":[]}'), []);
  assert.equal(parseAuthList('warning: something\n{"profiles":[{"id":"openai:a","type":"oauth"}]}\n').length, 1);
  assert.equal(parseAuthList(''), null);
  assert.equal(parseAuthList('not json'), null);
  assert.equal(parseAuthList('{"other":1}'), null);
  assert.equal(parseAuthList('{"profiles":[{"id":"openai:a","expiresAt":"nope"}]}')[0].expiresAt, null);
});

test('model list', () => {
  const out = JSON.stringify({ models: [
    { key: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 400000, input: ['text'] },
    { key: 'openai/gpt-6-astra', contextWindow: 1000000 },
    { name: 'no key' },
  ] });
  assert.deepEqual(parseModelList(out), [
    { key: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 400000 },
    { key: 'openai/gpt-6-astra', name: 'openai/gpt-6-astra', contextWindow: 1000000 },
  ]);
  assert.equal(parseModelList('nope'), null);
});

// ---- model transform (disconnect uses it; choosing a model is the agent panel's job) ----------------------------------------------------------------

const own = { primary: 'rev4a/deepseek-flash', fallbacks: ['rev4a/deepseek-v4-pro'] };

test('stop: the first own fallback becomes the primary again', () => {
  const used = { primary: 'openai/gpt-5.6-sol', fallbacks: ['rev4a/deepseek-flash', 'rev4a/deepseek-v4-pro'] };
  assert.deepEqual(stopSubscriptionModel(used), own);
});

test('stop when not used: unchanged', () => {
  assert.equal(stopSubscriptionModel(own), own);
  assert.equal(stopSubscriptionModel('rev4a/a'), 'rev4a/a');
  assert.equal(stopSubscriptionModel(null), null);
});

test('stop with no own fallback: unchanged', () => {
  const m = { primary: 'openai/x', fallbacks: [] };
  assert.equal(stopSubscriptionModel(m), m);
  const onlySub = { primary: 'openai/x', fallbacks: ['openai/y'] };
  assert.equal(stopSubscriptionModel(onlySub), onlySub);
});

test('stop: skips subscription fallbacks and keeps the rest', () => {
  assert.deepEqual(
    stopSubscriptionModel({ primary: 'openai/x', fallbacks: ['openai/y', 'rev4a/a', 'rev4a/b'] }),
    { primary: 'rev4a/a', fallbacks: ['openai/y', 'rev4a/b'] },
  );
});

test('a catalogue model that starts with rev4a/openai/ is not a subscription model', () => {
  const m = { primary: 'rev4a/openai/gpt-5.5', fallbacks: [] };
  assert.equal(stopSubscriptionModel(m), m);
});

// ---- parseStatusJson / formatPlan -----------------------------------------------------

test('status: full line from the in-container script', () => {
  const line = JSON.stringify({
    profiles: [{ id: 'openai:me@x.com', type: 'oauth', provider: 'openai', email: 'me@x.com', expiresAt: '2026-10-18T10:00:00.000Z', plan: 'plus' }],
    model: { primary: 'openai/gpt-5.6-sol', fallbacks: ['rev4a/a'] },
  });
  const s = parseStatusJson('(node:1) ExperimentalWarning: SQLite\n' + line + '\n');
  assert.equal(s.legacy, false);
  assert.equal(s.error, null);
  assert.deepEqual(s.profiles, [{ id: 'openai:me@x.com', type: 'oauth', provider: 'openai', email: 'me@x.com', expiresAt: '2026-10-18T10:00:00.000Z', plan: 'Plus' }]);
  assert.deepEqual(s.model, { primary: 'openai/gpt-5.6-sol', fallbacks: ['rev4a/a'] });
});

test('status: missing fields become null, a missing profile list is empty', () => {
  const s = parseStatusJson('{"profiles":[{"id":"openai:a"}],"model":{"primary":"rev4a/a"}}');
  assert.deepEqual(s.profiles, [{ id: 'openai:a', type: null, provider: null, email: null, expiresAt: null, plan: null }]);
  assert.deepEqual(s.model, { primary: 'rev4a/a', fallbacks: [] });
  const none = parseStatusJson('{"model":null,"error":"config"}');
  assert.deepEqual(none.profiles, []);
  assert.equal(none.model, null);
  assert.equal(none.error, 'config');
});

test('status: legacy marker, garbage and empty output', () => {
  assert.equal(parseStatusJson('{"legacy":true}').legacy, true);
  assert.equal(parseStatusJson(''), null);
  assert.equal(parseStatusJson('not json'), null);
  assert.equal(parseStatusJson('{"profiles":"x"}').profiles.length, 0);
});

test('status: tokens and the account id are stripped if they ever arrive', () => {
  const raw = JSON.stringify({
    profiles: [{ id: 'openai:a', type: 'oauth', email: 'a@x.com', access: 'ACCESS-SECRET', refresh: 'REFRESH-SECRET', accountId: 'ACCT-SECRET', expires: 1, chatgptPlanType: 'pro', plan: 'pro' }],
    model: { primary: 'p', fallbacks: [], access: 'ACCESS-SECRET' },
    access: 'ACCESS-SECRET',
  });
  const s = parseStatusJson(raw);
  const out = JSON.stringify(s);
  for (const secret of ['ACCESS-SECRET', 'REFRESH-SECRET', 'ACCT-SECRET']) assert.ok(!out.includes(secret), secret);
  assert.deepEqual(Object.keys(s.profiles[0]).sort(), ['email', 'expiresAt', 'id', 'plan', 'provider', 'type']);
  assert.deepEqual(Object.keys(s.model).sort(), ['fallbacks', 'primary']);
});

test('plan: capitalised, unknown shows nothing', () => {
  assert.equal(formatPlan('plus'), 'Plus');
  assert.equal(formatPlan('PRO'), 'Pro');
  assert.equal(formatPlan('Team'), 'Team');
  assert.equal(formatPlan('pro lite'), 'Pro Lite');
  assert.equal(formatPlan(''), null);
  assert.equal(formatPlan(null), null);
  assert.equal(formatPlan(undefined), null);
  assert.equal(formatPlan(42), null);
  assert.equal(formatPlan('<script>'), null);
});

test('store profile: a bad expiry gives null and never throws', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1e300, 8.64e15 + 1, -1e15, 253402300800000]) {
    const p = mapStoreProfile('openai:a', { type: 'oauth', expires: bad });
    assert.equal(p.expiresAt, null, String(bad));
  }
  assert.equal(mapStoreProfile('openai:a', { expires: '1700000000000' }).expiresAt, null);
  assert.equal(mapStoreProfile('openai:a', { expires: 1700000000000 }).expiresAt, '2023-11-14T22:13:20.000Z');
});

test('store profile: text fields only when they are strings', () => {
  const p = mapStoreProfile('openai:a', { type: 5, provider: {}, email: ['x'], chatgptPlanType: 7, access: 'SECRET' });
  assert.deepEqual(p, { id: 'openai:a', type: null, provider: null, email: null, expiresAt: null, plan: null });
  const q = mapStoreProfile('openai:b', { type: 'oauth', provider: 'openai', email: 'b@x.com', chatgptPlanType: 'plus', expires: 1700000000000 });
  assert.equal(q.email, 'b@x.com');
  assert.equal(q.plan, 'plus');
  assert.deepEqual(mapStoreProfile('openai:c', null), { id: 'openai:c', type: null, provider: null, email: null, expiresAt: null, plan: null });
});

// ---- STATUS_SCRIPT_SRC, executed for real against fixtures ------------------------------
test('status script: runs as written and never prints the tokens', () => {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'rev4a-sub-'));
  try {
    const db = pathx.join(dir, 'openclaw.sqlite');
    const cfg = pathx.join(dir, 'openclaw.json');
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)');
    const store = { version: 1, profiles: {
      'openai:a@b.c': { type: 'oauth', provider: 'openai', access: 'SECRET_ACCESS', refresh: 'SECRET_REFRESH', accountId: 'SECRET_ID', expires: 1791000000000, email: 'a@b.c', chatgptPlanType: 'plus' },
    } };
    d.prepare('INSERT INTO config_machine_state VALUES (?, ?, 0)').run('authProfiles.store', JSON.stringify(store));
    d.close();
    fsx.writeFileSync(cfg, JSON.stringify({ agents: { defaults: { model: { primary: 'openai/gpt-5.6-sol', fallbacks: ['rev4a/deepseek/deepseek-flash'] } } } }));
    const script = STATUS_SCRIPT_SRC
      .split('/root/.openclaw/state/openclaw.sqlite').join(db)
      .split('/root/.openclaw/openclaw.json').join(cfg);
    assert.notEqual(script, STATUS_SCRIPT_SRC, 'the fixed paths are in the script');
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
    assert.equal(/SECRET_/.test(out), false);
    const st = parseStatusJson(out);
    assert.equal(st.legacy, false);
    assert.equal(st.profiles[0].email, 'a@b.c');
    assert.equal(st.profiles[0].plan, 'Plus');
    assert.equal(st.model.primary, 'openai/gpt-5.6-sol');
    const missing = execFileSync(process.execPath, ['--no-warnings', '-e', STATUS_SCRIPT_SRC.split('/root/.openclaw/state/openclaw.sqlite').join(pathx.join(dir, 'none.sqlite'))], { encoding: 'utf8' });
    assert.equal(parseStatusJson(missing).legacy, true);
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- parseUsageStatus ----------------------------------------------------------------

const USAGE = JSON.stringify({ other: 1, usage: { updatedAt: 1791556475898, providers: [
  { provider: 'openai', displayName: 'OpenAI', plan: 'plus', accountEmail: 'a@b.c', secret: 'x',
    windows: [{ label: '5h', usedPercent: 14, resetAt: 1791573920000 }, { label: 'Week', usedPercent: 2, resetAt: 1792160720000 }],
    billing: [{ type: 'balance', amount: 0 }] },
  { provider: 'anthropic', windows: [{ label: 'x', usedPercent: 1, resetAt: 1 }] },
] } });

test('usage: openai windows only, after non-JSON lines', () => {
  const r = parseUsageStatus('warning: something\n' + USAGE + '\n');
  assert.equal(r.accounts.length, 1);
  const a = r.accounts[0];
  assert.equal(a.email, 'a@b.c');
  assert.equal(a.plan, 'Plus');
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent]), [['5h', 14], ['Week', 2]]);
  assert.equal(a.windows[0].resetAt, new Date(1791573920000).toISOString());
  assert.equal(a.updatedAt, new Date(1791556475898).toISOString());
  assert.equal(JSON.stringify(r).includes('secret'), false);
});

test('usage: clamps numbers, nulls bad dates, tolerates junk', () => {
  const r = parseUsageStatus(JSON.stringify({ usage: { providers: [{ provider: 'openai', windows: [
    { label: '5h', usedPercent: 140, resetAt: 'nope' }, { label: 'Week', usedPercent: -3 }, { usedPercent: 5 }, null,
  ] }] } }));
  const a = r.accounts[0];
  assert.equal(a.email, null);
  assert.equal(a.plan, null);
  assert.equal(a.updatedAt, null);
  assert.deepEqual(a.windows, [{ label: '5h', usedPercent: 100, resetAt: null }, { label: 'Week', usedPercent: 0, resetAt: null }]);
  assert.deepEqual(parseUsageStatus('not json'), { accounts: [] });
  assert.deepEqual(parseUsageStatus(''), { accounts: [] });
  assert.deepEqual(parseUsageStatus(null), { accounts: [] });
});

// ---- review fixes ---------------------------------------------------------------------

test('login deadline: 900 s login + 60 s readiness + 60 s tail', () => {
  assert.equal(LOGIN_DEADLINE_S, 1020);
  assert.equal(loginDeadlineAt(1000), 1000 + 1020 * 1000);
});

test('usage cache: a fresh result or failure is used, refresh and stale entries read', () => {
  const ttl = 180_000;
  assert.equal(usageCacheAction(undefined, 1000, false, ttl), 'read');
  assert.equal(usageCacheAction({ at: 1000 }, 1000 + ttl - 1, false, ttl), 'use');
  assert.equal(usageCacheAction({ at: 1000 }, 1000 + ttl, false, ttl), 'read');
  assert.equal(usageCacheAction({ at: 1000 }, 1001, true, ttl), 'read');
});

test('chip: subscription primary without fallback warns, with fallbacks is neutral', () => {
  assert.equal(subscriptionChip('openai/gpt-5.6-sol', 0), 'NO FALLBACK');
  assert.equal(subscriptionChip('openai/gpt-5.6-sol', 2), null);
  assert.equal(subscriptionChip('rev4a/openai/gpt-5.6-sol', 0), null);
  assert.equal(subscriptionChip(null, 0), null);
});

test('revert: primary goes back to the first own fallback, subscription fallbacks dropped', () => {
  const r = revertSubscriptionModel({ primary: 'openai/a', fallbacks: ['openai/b', 'rev4a/x', 'rev4a/y'] });
  assert.deepEqual([r.stuck, r.changed, r.primary, r.fallbacks], [false, true, 'rev4a/x', ['rev4a/y']]);
  assert.equal(revertSubscriptionModel({ primary: 'openai/a', fallbacks: [] }).stuck, true);
  const home = revertSubscriptionModel({ primary: 'openai/a', fallbacks: ['openai/b'] }, 'rev4a/h');
  assert.deepEqual([home.stuck, home.primary, home.fallbacks], [false, 'rev4a/h', []]);
  const keep = revertSubscriptionModel({ primary: 'rev4a/x', fallbacks: ['rev4a/y'] });
  assert.equal(keep.changed, false);
  assert.equal(revertSubscriptionModel({ primary: 'rev4a/x', fallbacks: ['openai/a'] }).changed, true);
});

test('stored refs: bare openai/ and rev4a/ pass unchanged, others get the prefix', () => {
  assert.equal(keepStoredRef('openai/gpt-5.6-sol'), 'openai/gpt-5.6-sol');
  assert.equal(keepStoredRef('rev4a/openai/gpt-5.6-sol'), 'rev4a/openai/gpt-5.6-sol');
  assert.equal(keepStoredRef('deepseek-flash'), 'rev4a/deepseek-flash');
});

test('stop codex script: valid sh, kills only the Codex runtime, never its own shell', () => {
  execFileSync('sh', ['-n', '-c', STOP_CODEX_SCRIPT]);
  // The case pattern on real command lines seen in an agent (2026-10-09).
  const match = (cmd) => execFileSync('sh', ['-c', 'case "$1" in */openclaw-codex-*/node_modules/@openai/codex*) echo y;; *) echo n;; esac', 'x', cmd], { encoding: 'utf8' }).trim();
  assert.ok(STOP_CODEX_SCRIPT.includes('*/openclaw-codex-*/node_modules/@openai/codex*'));
  assert.equal(match('node --no-opt -r /proc/.reset /root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex/bin/codex.js app-server'), 'y');
  assert.equal(match('/root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex app-server'), 'y');
  assert.equal(match('node /usr/local/bin/openclaw gateway --bind lan --port 3000'), 'n');
  assert.equal(match('openclaw models auth login --provider openai --device-code'), 'n');
  assert.ok(STOP_CODEX_SCRIPT.includes('"$$"'), 'skips its own shell');
});

console.log(`\n${n} tests passed`);
