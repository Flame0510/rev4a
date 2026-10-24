'use strict';

/**
 * Spend and loop alarms (FEAT-15), evaluated from what Rev4a already measures: the proxy
 * metering in costs.db (`proxy_usage_hourly`), the vendors' balance readings (`vendor_balance`)
 * and the Lineage session copy in events.db (`agent_sessions`). Pure SQL on two database
 * handles, no I/O of its own: daemon.js runs one pass after each costs pass and delivers what
 * the pass hands to `deliver` (a system_anomaly event and, when configured, a Telegram message).
 *
 * The 2026-10-07 incident is the model. A session context of ~560k tokens against a 200k window;
 * a compaction that timed out on every Telegram retry; ~101 model calls an hour for 14 hours at
 * ~64k prompt tokens each (the provider rejects a prompt over the model limit, so no call ever
 * carried 560k); $6.81 in all, about $0.49 an hour. OpenClaw does not record a failed
 * compaction, so the spend rules read ONLY the proxy's figures, never the costs agents recorded.
 * Alarms only: nothing is blocked or throttled.
 *
 * Rules (metric in brackets):
 *   session     [spend.session]     a session at 100 % of its model's context window or more (400 000
 *                                   tokens when the window is unknown; a healthy session compacts before
 *                                   its window, so it never gets there); cron runs excluded; resolved
 *                                   only when the session is seen again under 90 %
 *   loop        [spend.loop]        last full hour: errors + no_usage >= 10 and >= 50 % of the
 *                                   calls and >= 1 M prompt tokens
 *   unusual     [spend.unusual]     rolling 24 h cost (tokens, unpriced) > 3x the agent's median
 *                                   day over its ACTIVE days of the previous 28, and above a floor;
 *                                   fewer than 3 active days: a higher floor alone, one alarm a day
 *   unaccounted [spend.unaccounted] per vendor: USD balance drop between the last two readings > 2x
 *                                   the metered cost of that provider in the window and > $0.50; never
 *                                   twice for one reading, no resolved note, one a day once it has
 *                                   fired twice in 7 days (a key shared with another install)
 *
 * State lives in events.db `alert_state` (the table lib/alerts.ts already uses), written only AFTER
 * an alarm was delivered, so a pass that throws sets no cooldown: `spend:<rule>:<scope>` rows,
 * `spend-hour:` marks (hours that raised an alarm, kept out of the medians) and `spend-snooze:`.
 *
 * Missing data never reads as zero: a metering gap (markMeteringGap) skips the proxy rules for the
 * hours it touches and keeps them out of the medians; a balance older than 2 h skips `unaccounted`.
 * No full scan: every proxy query is bounded to the last 29 days of hours (the key starts with hour).
 */

const fs = require('fs');
const path = require('path');

const HOUR_S = 3600;
const HOUR_MS = HOUR_S * 1000;
const DAY_S = 24 * HOUR_S;

const RULES = ['session', 'loop', 'unusual', 'unaccounted'];
const METRIC = {
  session: 'spend.session',
  loop: 'spend.loop',
  unusual: 'spend.unusual',
  unaccounted: 'spend.unaccounted',
};

const KIND_STATE = 'spend';
const KIND_HOUR = 'spend-hour';
const KIND_SNOOZE = 'spend-snooze';
const HOUR_MARK_RETENTION_MS = 30 * 24 * HOUR_MS;
const UNACCOUNTED_WINDOW_MS = 7 * 24 * HOUR_MS;
const STATE_RETENTION_MS = 30 * 24 * HOUR_MS;
/** An alarm that stayed false this many evaluations in a row is resolved. */
const CLEAR_EVALUATIONS = 2;
/** A scope (an agent id, a container name or `vendor:<name>`): nothing a LIKE or a path could misread. */
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_SNOOZE_HOURS = 24;
const MAX_SNOOZE_HOURS = 24 * 30;
/** A gap that began in the last two minutes of an hour also touches the next one (rows land by call start). */
const GAP_SPILL_MS = 2 * 60 * 1000;
const HISTORY_DAYS = 28;

/** A positive finite number, else the default (zero, negative, NaN and text all fall back). */
const pos = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
/** A share in (0, 1]. */
const share = (v, d) => {
  const n = pos(v, d);
  return n <= 1 ? n : d;
};

/** Thresholds, from the environment (REV4A_SPEND_*) with the defaults documented in docs/REV4A.md. */
function configFromEnv(env) {
  const e = env || {};
  const sessionShare = share(e.REV4A_SPEND_SESSION_SHARE, 1);
  return {
    enabled: String(e.REV4A_SPEND_ALERTS ?? 'true').toLowerCase() !== 'false',
    sessionShare,
    // Back under this and seen again: resolved. Always below the alarm level (0.9 by default).
    sessionClearShare: Math.max(0.05, sessionShare - 0.1),
    sessionFallbackTokens: pos(e.REV4A_SPEND_SESSION_TOKENS, 400_000),
    sessionWindowMs: 6 * HOUR_MS,
    loopMinFailures: pos(e.REV4A_SPEND_LOOP_MIN_FAILURES, 10),
    loopMinShare: share(e.REV4A_SPEND_LOOP_MIN_SHARE, 0.5),
    loopMinPromptTokens: pos(e.REV4A_SPEND_LOOP_MIN_PROMPT_TOKENS, 1_000_000),
    dayRatio: pos(e.REV4A_SPEND_DAY_RATIO, 3),
    dayFloorUsd: pos(e.REV4A_SPEND_DAY_FLOOR_USD, 2),
    dayFloorTokens: pos(e.REV4A_SPEND_DAY_FLOOR_TOKENS, 20_000_000),
    dayNewFloorUsd: pos(e.REV4A_SPEND_DAY_NEW_FLOOR_USD, 5),
    dayNewFloorTokens: pos(e.REV4A_SPEND_DAY_NEW_FLOOR_TOKENS, 50_000_000),
    dayMinActiveDays: pos(e.REV4A_SPEND_DAY_MIN_ACTIVE_DAYS, 3),
    dayCooldownMs: pos(e.REV4A_SPEND_DAY_COOLDOWN_MS, 6 * HOUR_MS),
    dayNewCooldownMs: pos(e.REV4A_SPEND_DAY_NEW_COOLDOWN_MS, 24 * HOUR_MS),
    unaccountedRatio: pos(e.REV4A_SPEND_UNACCOUNTED_RATIO, 2),
    unaccountedMinUsd: pos(e.REV4A_SPEND_UNACCOUNTED_MIN_USD, 0.5),
    unaccountedRepeatCooldownMs: pos(e.REV4A_SPEND_UNACCOUNTED_REPEAT_COOLDOWN_MS, 24 * HOUR_MS),
    cooldownMs: pos(e.REV4A_SPEND_COOLDOWN_MS, HOUR_MS),
  };
}

const hourOf = (nowMs) => Math.floor(nowMs / 1000 / HOUR_S) * HOUR_S;

const STATE_DDL = `
CREATE TABLE IF NOT EXISTS alert_state (
  alert_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  last_sent_at INTEGER,
  last_resolved_at INTEGER,
  updated_at INTEGER NOT NULL,
  payload TEXT
)`;

function ensureStateTable(db) {
  db.exec(STATE_DDL);
}

// ── Metering gap marker ──────────────────────────────────────────────────────
// The proxy (the Next.js process) pauses its metering when costs.db cannot be written; the
// daemon is another process and cannot see that. The proxy leaves the moment of the pause in
// a small file next to costs.db, and the daemon skips the proxy rules for the hours it touches.

const GAP_FILE = 'proxy-metering-gap';

function gapPathFor(costsDbPath) {
  return path.join(path.dirname(costsDbPath), GAP_FILE);
}

/** Best effort, never throws: the moment (ms) a call could not be metered. */
function markMeteringGap(costsDbPath, atMs) {
  try {
    fs.writeFileSync(gapPathFor(costsDbPath), String(Math.floor(atMs ?? Date.now())), { mode: 0o600 });
  } catch { /* the marker is a courtesy to the alarms; metering never depends on it */ }
}

/** The last recorded gap in ms, or 0 for none / unreadable. */
function readMeteringGap(costsDbPath) {
  try {
    const n = Number(fs.readFileSync(gapPathFor(costsDbPath), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The hour starts (seconds) a gap at `gapAtMs` touches: its own hour, and the next when it began in the last 2 minutes. */
function gapHours(gapAtMs) {
  if (!gapAtMs) return [];
  const h = hourOf(gapAtMs);
  const late = gapAtMs % HOUR_MS >= HOUR_MS - GAP_SPILL_MS;
  return late ? [h, h + HOUR_S] : [h];
}

// ── Snooze ───────────────────────────────────────────────────────────────────

function isValidScope(scope) {
  return typeof scope === 'string' && SCOPE_RE.test(scope);
}

/** Snooze alarms of one agent (or `vendor:<name>`) for `hours` (default 24). Returns the end, in ms. */
function snooze(stateDb, scope, hours, nowMs) {
  if (!isValidScope(scope)) throw new Error('invalid agent');
  const h = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Math.min(Number(hours), MAX_SNOOZE_HOURS) : DEFAULT_SNOOZE_HOURS;
  const now = nowMs ?? Date.now();
  const until = now + h * HOUR_MS;
  ensureStateTable(stateDb);
  stateDb.prepare(
    `INSERT INTO alert_state (alert_key, kind, state, updated_at, payload) VALUES (?, ?, 'snoozed', ?, ?)
     ON CONFLICT(alert_key) DO UPDATE SET state='snoozed', updated_at=excluded.updated_at, payload=excluded.payload`,
  ).run(`${KIND_SNOOZE}:${scope}`, KIND_SNOOZE, now, JSON.stringify({ until }));
  return until;
}

/** Map of scope to end (ms) for the snoozes still running. */
function activeSnoozes(stateDb, nowMs) {
  const out = new Map();
  const now = nowMs ?? Date.now();
  let rows;
  try {
    rows = stateDb.prepare('SELECT alert_key, payload FROM alert_state WHERE kind = ?').all(KIND_SNOOZE);
  } catch {
    return out;
  }
  for (const r of rows) {
    try {
      const until = Number(JSON.parse(r.payload).until);
      if (until > now) out.set(r.alert_key.slice(KIND_SNOOZE.length + 1), until);
    } catch { /* a malformed row snoozes nothing */ }
  }
  return out;
}

// ── Rules (pure: figures in, a verdict out) ──────────────────────────────────

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtUsd = (n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** Median of a list of numbers (the list is not modified). */
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `h` is the last full hour's figures of one agent. */
function ruleLoop(h, cfg) {
  const failures = h.errors + h.noUsage;
  if (failures < cfg.loopMinFailures || h.calls <= 0 || failures / h.calls < cfg.loopMinShare || h.prompt < cfg.loopMinPromptTokens) return null;
  return {
    values: [failures, h.calls, h.prompt],
    threshold: cfg.loopMinFailures,
    message: `{agent}: ${failures} of ${h.calls} model calls failed or reported no usage in the last hour, with ${fmtInt(h.prompt)} prompt tokens. It looks like a failing retry loop.`,
  };
}

/**
 * `win` is the rolling 24 h ({cost, tokens}); `days` the {cost, tokens} of the agent's active days of
 * the previous 28 (days with a call, minus the ones a gap or an earlier alarm makes unreliable).
 */
function ruleDay(win, days, cfg) {
  const haveHistory = days.length >= cfg.dayMinActiveDays;
  let priced = win.cost > 0;
  // A model priced only lately: its earlier days cost nothing, so a cost median of 0 says nothing. Tokens decide.
  if (priced && haveHistory && median(days.map((d) => d.cost)) === 0 && median(days.map((d) => d.tokens)) > 0) priced = false;
  const value = priced ? win.cost : win.tokens;
  if (!(value > 0)) return null;
  const floor = haveHistory
    ? (priced ? cfg.dayFloorUsd : cfg.dayFloorTokens)
    : (priced ? cfg.dayNewFloorUsd : cfg.dayNewFloorTokens);
  if (!(value > floor)) return null;
  let med = null;
  if (haveHistory) {
    med = median(days.map((d) => (priced ? d.cost : d.tokens)));
    if (!(value > cfg.dayRatio * med)) return null;
  }
  const what = priced ? fmtUsd(value) : `${fmtInt(value)} tokens`;
  const usual = med === null
    ? 'it has fewer than 3 active days of metering, so only a higher floor applies'
    : `its usual day is ${priced ? fmtUsd(med) : `${fmtInt(med)} tokens`}`;
  return {
    values: [priced ? Number(value.toFixed(4)) : Math.round(value), med === null ? 0 : priced ? Number(med.toFixed(4)) : Math.round(med)],
    threshold: floor,
    floorOnly: !haveHistory,
    message: `{agent}: ${what} in the last 24 hours; ${usual}.`,
  };
}

/** A session row: the alarm level and the level it must be seen under to resolve. */
function sessionLevels(contextTokens, cfg) {
  const limit = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
  return {
    limit,
    fire: limit ? cfg.sessionShare * limit : cfg.sessionFallbackTokens,
    clear: limit ? cfg.sessionClearShare * limit : cfg.sessionClearShare * cfg.sessionFallbackTokens,
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * Evaluate every rule once and apply the state machine. Each alarm goes to `deliver(event)` (default:
 * collected and returned); the rule's state is written only after `deliver` returned, so a delivery
 * that throws leaves no cooldown behind and the next pass tries again.
 *
 * event: `{ rule, metric, scope, agent, container, vendor, session_key, message, values, threshold, hour, resolved }`
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.costsDb
 * @param {import('better-sqlite3').Database} deps.stateDb   events.db (alert_state, agent_sessions)
 * @param {number} [deps.nowMs]
 * @param {ReturnType<typeof configFromEnv>} [deps.config]
 * @param {number} [deps.gapAtMs]   the last metering gap (readMeteringGap); 0 for none
 * @param {(agent: string) => string | null} [deps.resolveContainer]
 * @param {(event: object) => void} [deps.deliver]
 * @param {(error: Error, event: object) => void} [deps.onError]   a delivery that threw: logged, the pass goes on
 */
function runSpendPass(deps) {
  const cfg = deps.config || configFromEnv({});
  const out = [];
  if (!cfg.enabled) return out;
  const deliver = deps.deliver || ((ev) => { out.push(ev); });
  const now = deps.nowMs ?? Date.now();
  const { costsDb, stateDb } = deps;
  const resolveContainer = deps.resolveContainer || (() => null);
  const gapAt = deps.gapAtMs || 0;
  const cur = hourOf(now); // the current (partial) hour
  const hour = cur - HOUR_S; // the last full hour
  ensureStateTable(stateDb);
  const snoozes = activeSnoozes(stateDb, now);
  const isSnoozed = (...scopes) => scopes.some((s) => s && snoozes.has(s));
  const touched = new Set(gapHours(gapAt));

  const getState = stateDb.prepare('SELECT state, last_sent_at, payload FROM alert_state WHERE alert_key = ?');
  const putState = stateDb.prepare(
    `INSERT INTO alert_state (alert_key, kind, state, last_sent_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(alert_key) DO UPDATE SET state=excluded.state, last_sent_at=excluded.last_sent_at, updated_at=excluded.updated_at, payload=excluded.payload`,
  );
  const parse = (p) => { try { return JSON.parse(p || '{}') || {}; } catch { return {}; } };

  /**
   * One rule and scope. `verdict`: `{ fire: finding }`, `{ clear: true }` (seen back to normal) or `{}`
   * (nothing known: no change). Optional `ctx`:
   *   cooldown(payload)  the cooldown before another alarm (default cfg.cooldownMs)
   *   once               never repeat while the alarm is open (a session)
   *   sticky             the cooldown also holds after a resolved note / a silent clear (the balance rule)
   *   reading            an id of the data behind this finding: never alarm twice for the same one
   *   track              keep the alarms of the last 7 days in the state; `build(message, n)` gets n
   *   silentResolve      no "back to normal" note
   * A delivery that throws is logged (`deps.onError`) and leaves that alarm's state as it was; the pass goes on.
   */
  function settle(rule, scope, verdict, ctx) {
    const key = `${KIND_STATE}:${rule}:${scope}`;
    const row = getState.get(key);
    const alerted = row?.state === 'alerted';
    const payload = parse(row?.payload);
    const base = { rule, metric: METRIC[rule], scope, agent: ctx.agent ?? null, container: ctx.container ?? null, vendor: ctx.vendor ?? null, session_key: ctx.session_key ?? null, hour: ctx.hour ?? hour };
    const muted = isSnoozed(scope, ctx.agent, ctx.container);
    const named = (text) => text.replace('{agent}', ctx.label || scope);
    const keep = { alarms: payload.alarms, reading: payload.reading };
    if (verdict.fire) {
      const lastSent = Number(row?.last_sent_at || 0);
      const cooldown = ctx.cooldown ? ctx.cooldown(payload) : cfg.cooldownMs;
      if (ctx.reading !== undefined && payload.reading === ctx.reading) return; // this reading was already acted on
      if ((alerted || ctx.sticky) && lastSent && (ctx.once || now - lastSent < cooldown)) {
        if (alerted) putState.run(key, KIND_STATE, 'alerted', lastSent, now, JSON.stringify({ ...payload, clear: 0 }));
        return;
      }
      if (muted) return; // evaluated, not alerted: the snooze ends, the next pass alerts
      const alarms = ctx.track ? [...(payload.alarms || []).filter((t) => t > now - UNACCOUNTED_WINDOW_MS), now] : undefined;
      const n = alarms ? alarms.length : 1;
      const f = verdict.fire;
      try {
        deliver({ ...base, message: named(ctx.build ? ctx.build(f.message, n) : f.message), values: f.values, threshold: f.threshold, resolved: false });
      } catch (e) {
        if (deps.onError) deps.onError(e, base);
        return;
      }
      putState.run(key, KIND_STATE, 'alerted', now, now, JSON.stringify({ clear: 0, alarms, reading: ctx.reading }));
      return;
    }
    if (!verdict.clear || !alerted) return;
    const clear = Number(payload.clear || 0) + 1;
    if (clear < CLEAR_EVALUATIONS) {
      putState.run(key, KIND_STATE, 'alerted', row.last_sent_at, now, JSON.stringify({ ...payload, clear }));
      return;
    }
    if (!muted && !ctx.silentResolve) {
      try {
        deliver({ ...base, message: named(ctx.resolvedMessage || `{agent}: back to normal (${METRIC[rule]}).`), values: [], threshold: null, resolved: true });
      } catch (e) {
        if (deps.onError) deps.onError(e, base);
        return;
      }
    }
    putState.run(key, KIND_STATE, 'ok', row.last_sent_at, now, JSON.stringify({ clear: 0, ...keep }));
  }

  const markHour = stateDb.prepare(
    `INSERT INTO alert_state (alert_key, kind, state, updated_at) VALUES (?, ?, 'alarm', ?)
     ON CONFLICT(alert_key) DO UPDATE SET updated_at = excluded.updated_at`,
  );
  const openStates = (rule) => stateDb.prepare("SELECT alert_key FROM alert_state WHERE kind = ? AND state = 'alerted' AND alert_key LIKE ?")
    .all(KIND_STATE, `${KIND_STATE}:${rule}:%`).map((r) => r.alert_key.slice(`${KIND_STATE}:${rule}:`.length));

  // Rule: failing loop, from the last full hour. Skipped when the metering paused during or after it.
  const gapHitsHour = gapAt >= hour * 1000 || touched.has(hour);
  if (!gapHitsHour) {
    const rows = costsDb.prepare(
      `SELECT agent, SUM(calls) AS calls, SUM(prompt_tokens) AS prompt, SUM(errors) AS errors, SUM(no_usage) AS no_usage
         FROM proxy_usage_hourly WHERE hour = ? GROUP BY agent`,
    ).all(hour);
    const byAgent = new Map(rows.map((r) => [r.agent, r]));
    for (const agent of new Set([...byAgent.keys(), ...openStates('loop')])) {
      const r = byAgent.get(agent);
      const f = ruleLoop({ calls: r?.calls || 0, prompt: r?.prompt || 0, errors: r?.errors || 0, noUsage: r?.no_usage || 0 }, cfg);
      if (f) markHour.run(`${KIND_HOUR}:${agent}:${hour}`, KIND_HOUR, now);
      settle('loop', agent, f ? { fire: f } : { clear: true }, { agent, container: resolveContainer(agent), label: agent, hour, resolvedMessage: '{agent}: the failing loop has stopped.' });
    }
  }

  // Rule: a day out of proportion. Blocks of 24 hours counted back from the current hour: block 0 is the
  // rolling last 24 h, blocks 1 to 28 the days before it. One bounded range read of 29 days.
  {
    const lo = cur - (HISTORY_DAYS + 1) * DAY_S;
    // Step 1, cheap: the rolling 24 h of every agent (about a day of rows). Only an agent over a floor, or with
    // an open alarm to resolve, needs its history; the rest cannot fire and are not read again.
    const nowRows = costsDb.prepare(
      `SELECT agent, SUM(calls) AS calls, SUM(cost) AS cost, SUM(prompt_tokens + completion_tokens) AS tokens
         FROM proxy_usage_hourly WHERE hour > ? AND hour <= ? GROUP BY agent`,
    ).all(cur - DAY_S, cur);
    const candidates = new Set(openStates('unusual'));
    for (const r of nowRows) if (r.cost > cfg.dayFloorUsd || r.tokens > cfg.dayFloorTokens) candidates.add(r.agent);
    const perAgent = new Map();
    for (const r of nowRows) if (candidates.has(r.agent)) perAgent.set(r.agent, new Map([[0, r]]));
    if (candidates.size) {
      const list = [...candidates];
      const filter = list.length <= 400 ? ` AND agent IN (${list.map(() => '?').join(', ')})` : '';
      const hist = costsDb.prepare(
        `SELECT agent, CAST((? - hour) / ${DAY_S} AS INTEGER) AS blk, SUM(calls) AS calls, SUM(cost) AS cost, SUM(prompt_tokens + completion_tokens) AS tokens
           FROM proxy_usage_hourly WHERE hour > ? AND hour <= ?${filter} GROUP BY agent, blk`,
      ).all(cur, lo, cur - DAY_S, ...(filter ? list : []));
      for (const r of hist) {
        if (!candidates.has(r.agent)) continue;
        if (!perAgent.has(r.agent)) perAgent.set(r.agent, new Map());
        perAgent.get(r.agent).set(r.blk, r);
      }
    }
    // Blocks a gap or an earlier alarm makes unreliable stay out of the medians.
    const badBlocks = new Map(); // agent -> Set(blk); '*' for every agent
    const addBad = (agent, h) => {
      const b = Math.floor((cur - h) / DAY_S);
      if (b < 1 || b > HISTORY_DAYS) return;
      if (!badBlocks.has(agent)) badBlocks.set(agent, new Set());
      badBlocks.get(agent).add(b);
    };
    for (const h of touched) addBad('*', h);
    for (const m of stateDb.prepare('SELECT alert_key FROM alert_state WHERE kind = ?').all(KIND_HOUR)) {
      const [, agent, h] = m.alert_key.split(':');
      if (agent && Number.isFinite(Number(h))) addBad(agent, Number(h));
    }
    for (const agent of candidates) {
      const blocks = perAgent.get(agent) || new Map();
      const w = blocks.get(0);
      const win = { cost: w?.cost || 0, tokens: w?.tokens || 0 };
      const skip = new Set([...(badBlocks.get('*') || []), ...(badBlocks.get(agent) || [])]);
      const days = [];
      for (let b = 1; b <= HISTORY_DAYS; b++) {
        const d = blocks.get(b);
        if (d && d.calls >= 1 && !skip.has(b)) days.push({ cost: d.cost || 0, tokens: d.tokens || 0 });
      }
      const f = ruleDay(win, days, cfg);
      if (f) markHour.run(`${KIND_HOUR}:${agent}:${cur}`, KIND_HOUR, now);
      settle('unusual', agent, f ? { fire: f } : { clear: true }, {
        agent, container: resolveContainer(agent), label: agent, hour: cur,
        // Judged on a floor alone (little history): at most one alarm a day.
        cooldown: () => (f?.floorOnly ? cfg.dayNewCooldownMs : cfg.dayCooldownMs),
        resolvedMessage: '{agent}: spend over the last 24 hours is back to its usual level.',
      });
    }
  }

  // Rule: money leaving the account, per vendor. Needs two fresh USD readings and no metering gap in the window.
  try {
    const vendors = costsDb.prepare('SELECT DISTINCT vendor FROM vendor_balance WHERE ts > ?').all(now - 3 * HOUR_MS).map((r) => r.vendor);
    for (const vendor of vendors) {
      const rd = costsDb.prepare('SELECT ts, balance, currency FROM vendor_balance WHERE vendor = ? AND balance IS NOT NULL ORDER BY ts DESC LIMIT 2').all(vendor);
      if (rd.length < 2 || now - rd[0].ts > 2 * HOUR_MS) continue; // no readings, or stale: skip, never alarm
      const [newer, older] = rd;
      // The proxy meters in USD. Another currency is not converted: the vendor is skipped.
      if (String(newer.currency || '').toUpperCase() !== 'USD' || String(older.currency || '').toUpperCase() !== 'USD') continue;
      if (gapAt >= older.ts - HOUR_MS - GAP_SPILL_MS) continue;
      const drop = older.balance - newer.balance;
      let verdict = { clear: true };
      if (drop > cfg.unaccountedMinUsd) {
        const metered = costsDb.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM proxy_usage_hourly WHERE provider = ? AND hour >= ? AND hour <= ?')
          .get(vendor, hourOf(older.ts), hourOf(newer.ts)).c;
        if (drop > cfg.unaccountedRatio * metered) {
          verdict = { fire: {
            values: [Number(drop.toFixed(4)), Number(metered.toFixed(4))],
            threshold: cfg.unaccountedMinUsd,
            message: `${vendor}: the balance dropped ${fmtUsd(drop)} between the last two readings, but Rev4a's proxy metered ${fmtUsd(metered)}. The key may be used outside Rev4a's agents (another app, an agent with its own key).`,
          } };
        }
      }
      settle('unaccounted', `vendor:${vendor}`, verdict, {
        vendor, label: vendor,
        sticky: true,
        silentResolve: true, // a balance that stops dropping is not news; a flapping key would send a note an hour
        reading: newer.ts,
        track: true,
        // After the 2nd alarm within 7 days (a key shared with another install): one a day at most.
        cooldown: (p) => ((p.alarms || []).filter((t) => t > now - UNACCOUNTED_WINDOW_MS).length >= 2 ? cfg.unaccountedRepeatCooldownMs : cfg.cooldownMs),
        build: (msg, n) => (n >= 2 ? `${msg} This keeps recurring (the key may be shared with another install), so further alarms are held back for 24 hours.` : msg),
      });
    }
  } catch { /* no vendor_balance table yet: nothing to read */ }

  // Rule: a session near the limit of its model's context window, from the Lineage copy (events.db).
  try {
    const sessions = stateDb.prepare(
      `SELECT container, session_key, total_tokens, context_tokens, updated_at FROM agent_sessions
        WHERE total_tokens IS NOT NULL AND COALESCE(kind, '') <> 'cron_run' AND gone_at IS NULL AND updated_at >= ?`,
    ).all(now - cfg.sessionWindowMs);
    const scopeOf = (s) => `${s.container}:${s.session_key}`;
    const one = (s, extra) => ({ agent: s.container, container: s.container, session_key: s.session_key, label: s.container, ...extra });
    for (const s of sessions) {
      const lv = sessionLevels(s.context_tokens, cfg);
      if (s.total_tokens < lv.fire) continue;
      const pct = lv.limit ? ` (${Math.round((s.total_tokens / lv.limit) * 100)} % of its ${fmtInt(lv.limit)}-token window)` : '';
      settle('session', scopeOf(s), { fire: {
        values: [s.total_tokens, lv.limit],
        threshold: Math.round(lv.fire),
        message: `{agent}: session ${s.session_key} holds ${fmtInt(s.total_tokens)} tokens of context${pct}. Compactions may be failing; each message resends all of it.`,
      } }, one(s, { once: true }));
    }
    // An alarmed session is resolved only when it is seen again, updated since the alarm, under the clear level.
    const read = stateDb.prepare('SELECT total_tokens, context_tokens, updated_at, gone_at FROM agent_sessions WHERE container = ? AND session_key = ?');
    for (const scope of openStates('session')) {
      const i = scope.indexOf(':');
      const container = scope.slice(0, i);
      const sessionKey = scope.slice(i + 1);
      const st = getState.get(`${KIND_STATE}:session:${scope}`);
      const r = read.get(container, sessionKey);
      const seenBack = r && r.total_tokens !== null && r.updated_at > Number(st?.last_sent_at || 0)
        && r.total_tokens < sessionLevels(r.context_tokens, cfg).clear;
      if (!seenBack) continue; // idle, gone or still large: the alarm stays open
      const s = { container, session_key: sessionKey };
      settle('session', scope, { clear: true }, one(s, { resolvedMessage: `{agent}: session ${sessionKey} is back under ${Math.round(cfg.sessionClearShare * 100)} % of its context window.` }));
    }
  } catch { /* no agent_sessions table: nothing to read */ }

  // Housekeeping: marks, old rule state and snoozes older than their use, in the same pass.
  stateDb.prepare('DELETE FROM alert_state WHERE kind = ? AND updated_at < ?').run(KIND_HOUR, now - HOUR_MARK_RETENTION_MS);
  stateDb.prepare('DELETE FROM alert_state WHERE kind = ? AND updated_at < ?').run(KIND_STATE, now - STATE_RETENTION_MS);
  for (const r of stateDb.prepare('SELECT alert_key, payload FROM alert_state WHERE kind = ?').all(KIND_SNOOZE)) {
    let until = 0;
    try { until = Number(JSON.parse(r.payload).until); } catch { /* malformed: drop it */ }
    if (!(until >= now - DAY_S * 1000)) stateDb.prepare('DELETE FROM alert_state WHERE alert_key = ?').run(r.alert_key);
  }
  return out;
}

module.exports = {
  RULES,
  METRIC,
  KIND_STATE,
  KIND_HOUR,
  KIND_SNOOZE,
  DEFAULT_SNOOZE_HOURS,
  configFromEnv,
  hourOf,
  median,
  isValidScope,
  snooze,
  activeSnoozes,
  markMeteringGap,
  readMeteringGap,
  gapPathFor,
  gapHours,
  ruleLoop,
  ruleDay,
  sessionLevels,
  runSpendPass,
};
