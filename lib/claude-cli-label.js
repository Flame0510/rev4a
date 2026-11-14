'use strict';
/**
 * Which cost and session rows ran on the operator's Claude plan.
 *
 * OpenClaw stores a turn run through Claude Code (`claude-cli` runtime) as provider `anthropic`
 * with no cost: nothing in the row tells it from a paid API call. Rev4a knows from the agent's
 * configuration: `agents.defaults.models["anthropic/*"].agentRuntime.id === "claude-cli"` is what
 * Connect writes. The daemon reads that rule per agent and keeps the days it was on, per container,
 * in `agent_cost_claude_cli` (costs.db); a row of provider `anthropic` that falls in one of those
 * days is stored as `claude-cli`, which the Costs page and Lineage treat as a subscription.
 *
 * Why days and not "the rule is on now": the cost aggregates (agent_cost_model_daily) are rewritten
 * from OpenClaw's own figures over the whole 30-day window on every pass, so a label decided from
 * the current state alone would relabel API calls made before Connect, and back again on Disconnect.
 * A label that is a function of (container, UTC date) is stable under that rewrite and cannot count
 * a call twice.
 *
 * Pure functions only (CommonJS, required by daemon.js); the I/O stays in the daemon.
 */

const CLAUDE_CLI_PROVIDER = 'claude-cli';
const CLAUDE_CLI_RUNTIME_ID = 'claude-cli';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_cost_claude_cli (
  container TEXT NOT NULL,
  since_date TEXT NOT NULL,
  until_date TEXT,
  last_on_date TEXT,
  PRIMARY KEY (container, since_date)
);`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether an agent's openclaw.json routes `anthropic/*` through Claude Code. `true` or `false` when
 * the text is a readable configuration; `null` when it is empty or not JSON (the state is unknown:
 * a failed read must not turn the rule off).
 */
function claudeRuleFromConfigText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(config)) return null;
  const models = config.agents?.defaults?.models;
  if (!isObject(models)) return false;
  const entry = models['anthropic/*'];
  const runtime = isObject(entry) ? entry.agentRuntime : null;
  return isObject(runtime) && runtime.id === CLAUDE_CLI_RUNTIME_ID;
}

/**
 * What to do to a container's stored intervals given the rule state read this pass.
 * `intervals`: [{ since_date, until_date, last_on_date }]. `state`: true, false or null (unknown).
 * An interval is "open" while until_date is null; `last_on_date` is the last date the rule was READ as on,
 * and an open interval covers days up to there, no further (days after the last good read stay unlabelled
 * until the next one, so failed reads after a Disconnect hide nothing).
 * Returns { open, reopen, touch, close, closeAt } (each a since_date or null; at most one action):
 *  - on: an open interval gets `touch` (last_on_date = today); else one that started today is `reopen`ed;
 *    else a new one is `open`ed from today.
 *  - off: the open interval is `close`d at `closeAt`, its last_on_date (not today).
 *  - unknown: nothing.
 */
function planIntervalChange(intervals, state, today) {
  const none = { open: null, reopen: null, touch: null, close: null, closeAt: null };
  if (state !== true && state !== false) return none;
  const list = Array.isArray(intervals) ? intervals : [];
  const openOne = list.find((i) => i.until_date === null || i.until_date === undefined);
  if (state === true) {
    if (openOne) return { ...none, touch: openOne.since_date };
    if (list.some((i) => i.since_date === today)) return { ...none, reopen: today };
    return { ...none, open: today };
  }
  return openOne ? { ...none, close: openOne.since_date, closeAt: openOne.last_on_date || openOne.since_date } : none;
}

/** The last day an interval covers: its end, or for an open one the last date the rule was read on. */
const endOf = (i) => i.until_date ?? i.last_on_date ?? i.since_date;

/** Whether a UTC date (YYYY-MM-DD) falls in one of the intervals (both ends included). */
function dateInIntervals(date, intervals) {
  if (typeof date !== 'string' || !Array.isArray(intervals)) return false;
  return intervals.some((i) => date >= i.since_date && date <= endOf(i));
}

/**
 * The provider to store for a row: `anthropic` becomes `claude-cli` on a day the rule was on, unless the
 * row carries a cost above 0. Claude Code turns are stored with cost 0 or none; a priced `anthropic` row is
 * evidence of paid API calls (OpenClaw merges both kinds of one model and day into one row, and that row
 * stays paid: correct money). Every other provider (including `rev4a`) and a row with no date are unchanged.
 */
function labelProvider(provider, date, intervals, cost) {
  if (provider !== 'anthropic') return provider;
  if (typeof cost === 'number' && cost > 0) return provider;
  return dateInIntervals(date, intervals) ? CLAUDE_CLI_PROVIDER : provider;
}

const utcDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

/**
 * Relabels agent_sessions rows (list rows and cron runs alike) in place, from the days the rule was on.
 * No cost guard here: a session's cost can be OpenClaw's estimate for a Claude Code turn (seen live), and
 * session rows never feed Spent. One helper for every path that stores session rows.
 */
function relabelSessionRows(rows, intervals) {
  if (!Array.isArray(rows) || !Array.isArray(intervals) || !intervals.length) return rows;
  for (const r of rows) {
    if (r && r.provider === 'anthropic') r.provider = labelProvider(r.provider, utcDay(r.updated_at), intervals);
  }
  return rows;
}

/**
 * OpenClaw's modelDaily rows as stored: provider relabelled per row, and rows that end up under the same
 * (date, provider, model) (a relabelled `anthropic` row next to a native `claude-cli` one) summed, because
 * the table is keyed on that and INSERT OR REPLACE would drop one. Row: { date, provider, model, tokens, cost, calls }.
 */
function labelModelDaily(rows, intervals) {
  const out = new Map();
  for (const r of rows) {
    const provider = labelProvider(r.provider, r.date, intervals, r.cost);
    const key = JSON.stringify([r.date, provider, r.model]);
    const prev = out.get(key);
    if (prev) {
      prev.tokens += r.tokens; prev.cost += r.cost; prev.calls += r.calls;
    } else {
      out.set(key, { ...r, provider });
    }
  }
  return [...out.values()];
}

const ADD_LAST_ON_COLUMN_SQL = 'ALTER TABLE agent_cost_claude_cli ADD COLUMN last_on_date TEXT';

module.exports = {
  CLAUDE_CLI_PROVIDER,
  CREATE_TABLE_SQL,
  claudeRuleFromConfigText,
  planIntervalChange,
  dateInIntervals,
  labelProvider,
  relabelSessionRows,
  labelModelDaily,
  ADD_LAST_ON_COLUMN_SQL,
};
