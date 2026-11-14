/**
 * Tests of the pure Subscriptions helpers (lib/subscriptions-parse.js).
 * Run: node scripts/test-subscriptions.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseDeviceLogin, parseModelList, stopSubscriptionModel,
  parseStatusJson, parseUsageStatus, formatPlan, mapStoreProfile, STATUS_SCRIPT_SRC,
  statusFailureReason, readWithRetry, loginDeadlineAt, LOGIN_DEADLINE_S, usageCacheAction, subscriptionChip, revertSubscriptionModel, keepStoredRef, STOP_CODEX_SCRIPT, majorMinor, isSupportedLine,
} = require('../lib/subscriptions-parse.js');
const { execFileSync } = require('node:child_process');
const fsx = require('node:fs');
const os = require('node:os');
const pathx = require('node:path');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

const atest = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

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

// ---- parseModelList ------------------------------------------------------------------

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
  assert.equal(s.unsupported, false);
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

test('status: unsupported marker, garbage and empty output', () => {
  const u = parseStatusJson('{"unsupported":true}');
  assert.equal(u.unsupported, true);
  assert.deepEqual(u.profiles, []);
  assert.equal(u.model, null);
  // The old marker is not understood any more: it is just a read without profiles.
  assert.equal(parseStatusJson('{"legacy":true}').unsupported, false);
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
    assert.equal(st.unsupported, false);
    assert.equal(st.profiles[0].email, 'a@b.c');
    assert.equal(st.profiles[0].plan, 'Plus');
    assert.equal(st.model.primary, 'openai/gpt-5.6-sol');
    const missing = execFileSync(process.execPath, ['--no-warnings', '-e', STATUS_SCRIPT_SRC.split('/root/.openclaw/state/openclaw.sqlite').join(pathx.join(dir, 'none.sqlite'))], { encoding: 'utf8' });
    assert.equal(parseStatusJson(missing).unsupported, true);
    // A state database without the profile table is the same refusal, not a read failure.
    const noTable = pathx.join(dir, 'empty.sqlite');
    const e = new DatabaseSync(noTable);
    e.exec('CREATE TABLE other (x TEXT)');
    e.close();
    const unsupported = execFileSync(process.execPath, ['--no-warnings', '-e', STATUS_SCRIPT_SRC.split('/root/.openclaw/state/openclaw.sqlite').join(noTable)], { encoding: 'utf8' });
    assert.equal(parseStatusJson(unsupported).unsupported, true);
    // A file that is not a database is a failed read: the script exits non-zero, nothing is printed.
    const junk = pathx.join(dir, 'junk.sqlite');
    fsx.writeFileSync(junk, 'this is not a database, '.repeat(200));
    const junkScript = STATUS_SCRIPT_SRC.split('/root/.openclaw/state/openclaw.sqlite').join(junk);
    let stderr = '';
    assert.throws(() => execFileSync(process.execPath, ['--no-warnings', '-e', junkScript], { encoding: 'utf8', stdio: 'pipe' }), (e) => { stderr = String(e.stderr); return e.status === 1; });
    // Only a fixed category reaches stderr, never the exception text.
    assert.equal(stderr.trim(), 'state database unreadable');
    // A profile row that is not JSON: its text must not be echoed either.
    const badRow = pathx.join(dir, 'badrow.sqlite');
    const br = new DatabaseSync(badRow);
    br.exec('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)');
    br.prepare('INSERT INTO config_machine_state VALUES (?, ?, 0)').run('authProfiles.store', '{"profiles": SECRET-TEXT}');
    br.close();
    const badScript = STATUS_SCRIPT_SRC.split('/root/.openclaw/state/openclaw.sqlite').join(badRow);
    assert.throws(() => execFileSync(process.execPath, ['--no-warnings', '-e', badScript], { encoding: 'utf8', stdio: 'pipe' }), (e) => {
      return e.status === 1 && String(e.stderr).trim() === 'profile store unreadable' && !String(e.stderr).includes('SECRET');
    });
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
  // The glob is written with a quote inside the word, so the script text never matches itself.
  assert.ok(STOP_CODEX_SCRIPT.includes('*/openclaw-codex-*/node_modules/@openai/"codex"*'));
  assert.equal(match(STOP_CODEX_SCRIPT), 'n', 'the script text does not match its own pattern (it is in the cmdline of its sh -c wrapper)');
  const own = STOP_CODEX_SCRIPT.match(/case "\$c" in (.+?)\) kill/)[1];
  const ownMatch = (cmd) => execFileSync('sh', ['-c', 'case "$1" in ' + own + ') echo y;; *) echo n;; esac', 'x', cmd], { encoding: 'utf8' }).trim();
  assert.equal(ownMatch('node -r /proc/.reset /root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex/bin/codex.js app-server'), 'y');
  assert.equal(ownMatch(STOP_CODEX_SCRIPT), 'n');
  assert.equal(match('node --no-opt -r /proc/.reset /root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex/bin/codex.js app-server'), 'y');
  assert.equal(match('/root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex app-server'), 'y');
  assert.equal(match('node /usr/local/bin/openclaw gateway --bind lan --port 3000'), 'n');
  assert.equal(match('openclaw models auth login --provider openai --device-code'), 'n');
  assert.ok(STOP_CODEX_SCRIPT.includes('"$$"'), 'skips its own shell');
});


// ---- failure reason and retry policy ---------------------------------------------------

test('failure reason: fixed categories only, never the raw text', () => {
  assert.equal(statusFailureReason('docker exec c: exit 1 — state database locked'), 'state database locked');
  assert.equal(statusFailureReason('docker exec c: exit 1 — profile store unreadable'), 'profile store unreadable');
  assert.equal(statusFailureReason('docker exec c: exit 1 — state database unreadable'), 'state database unreadable');
  assert.equal(statusFailureReason('docker exec c: timed out'), 'timed out');
  assert.equal(statusFailureReason('docker exec c: exit 1 — Error response from daemon: container c is not running'), 'the container is not running');
  const leak = statusFailureReason('docker exec c: exit 1 — SyntaxError: Unexpected token S in JSON at position 12 "SECRET-TEXT"');
  assert.equal(leak, 'the read failed');
  assert.equal(statusFailureReason(undefined), 'the read failed');
});

const noSleep = (log) => async (ms) => { log.push(ms); };
const seq = (answers) => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)]; };
const F = (reason) => ({ status: 'failed', reason });

await atest('retry: ok and unsupported are never retried', async () => {
  for (const a of [{ status: 'ok' }, { status: 'unsupported' }]) {
    const pauses = [];
    let calls = 0;
    const r = await readWithRetry(async () => { calls++; return a; }, [1000, 2000], noSleep(pauses));
    assert.equal(r.status, a.status);
    assert.equal(calls, 1);
    assert.deepEqual(pauses, []);
  }
});

await atest('retry: a transient failure recovers on the second or third read', async () => {
  const p1 = [];
  assert.equal((await readWithRetry(seq([F('the read failed'), { status: 'ok' }]), [1000, 2000], noSleep(p1))).status, 'ok');
  assert.deepEqual(p1, [1000]);
  const p2 = [];
  assert.equal((await readWithRetry(seq([F('the read failed'), F('the read failed'), { status: 'ok' }]), [1000, 2000], noSleep(p2))).status, 'ok');
  assert.deepEqual(p2, [1000, 2000]);
});

await atest('retry: a persistent failure stops after three reads', async () => {
  const pauses = [];
  let calls = 0;
  const r = await readWithRetry(async () => { calls++; return F('state database locked'); }, [1000, 2000], noSleep(pauses));
  assert.equal(r.status, 'failed');
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 2000]);
});

await atest('retry: a timeout is retried once, a stopped container never', async () => {
  let calls = 0;
  await readWithRetry(async () => { calls++; return F('timed out'); }, [1000, 2000], noSleep([]));
  assert.equal(calls, 2);
  calls = 0;
  await readWithRetry(async () => { calls++; return F('the read was cut off (timed out)'); }, [1000, 2000], noSleep([]));
  assert.equal(calls, 2);
  calls = 0;
  await readWithRetry(async () => { calls++; return F('the container is not running'); }, [1000, 2000], noSleep([]));
  assert.equal(calls, 1);
});

await atest('retry: no delays reads once', async () => {
  let calls = 0;
  await readWithRetry(async () => { calls++; return F('x'); }, [], noSleep([]));
  assert.equal(calls, 1);
});

test('majorMinor and isSupportedLine: any build of a supported line', () => {
  assert.equal(majorMinor('2026.9.3'), '2026.9');
  assert.equal(majorMinor('v2026.9.10-beta.1'), '2026.9');
  assert.equal(majorMinor('2026.9'), '2026.9');
  assert.equal(majorMinor('latest'), null);
  assert.equal(majorMinor(null), null);
  const supported = ['2026.9.3', '2026.7.1'];
  assert.equal(isSupportedLine('2026.9.9', supported), true);
  assert.equal(isSupportedLine('2026.7.4', supported), true);
  assert.equal(isSupportedLine('2026.8.1', supported), false);
  assert.equal(isSupportedLine('2026.10.0', supported), false);
  assert.equal(isSupportedLine(null, supported), false);
  assert.equal(isSupportedLine('2026.9.3', []), false);
});

console.log(`\n${n} tests passed`);
