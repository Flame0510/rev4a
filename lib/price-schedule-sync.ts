/**
 * Re-sync the agents' prices when a vendor's rate changes with the time of day.
 *
 * OpenClaw's `cost` has no notion of time: it prices each call with the rates in its
 * config at that moment and keeps that cost. DeepSeek bills half price off-peak, so at
 * every change of band the `rev4a` block is written again with the rates now in force
 * (`priceAt()` in `buildRev4aProviderConfig()`). A config patch of `models` applies
 * without a gateway restart.
 *
 * A check, not one long timer: at most every minute it compares the bands in force with
 * the ones last written, and syncs only when they differ. A single timeout to the next
 * change would fire late after the machine sleeps (a laptop), leaving every agent on
 * the other band's rates; the check costs a little arithmetic and no I/O. When the next
 * change is less than a minute away the check is set for that moment, so a change is
 * applied within a couple of seconds.
 *
 * The check runs whether or not a scheduled model is on offer, and skips the sync when
 * none is: enabling a DeepSeek model later needs no restart to be priced right. A sync
 * that did not reach every agent is retried every few minutes, not every check — a full
 * sync holds the server for a few seconds — and at most a few times: an agent busy with
 * an update, recreate, restore or edit writes the prices itself when it finishes, and one
 * that stays broken must not keep the server syncing every agent around the clock. A new
 * change of band is applied at once, whatever retry was pending.
 */
import { syncAllAgents } from '@/app/api/gateway/sync';
import { loadModelsConfig, loadOfferedModels } from '@/lib/model-catalogue';
import { PRICE_SCHEDULES, nextPriceChange, priceBandAt, priceScheduleFor } from '@/lib/model-pricing';

const CHECK_MS = 60_000;
/** Past the hour mark, so the band has changed when the sync reads the clock. */
const AFTER_CHANGE_MS = 2_000;
const RETRY_MS = 5 * 60_000;
/** Syncs tried for one band before waiting for the next change (or the next save or restart). */
const MAX_TRIES = 3;

interface State {
  timer?: ReturnType<typeof setTimeout>;
  /**
   * The bands last written to the agents, e.g. `deepseek:off-peak`. Set by every sync,
   * complete or not: a sync that misses one agent still writes every other one.
   */
  applied?: string;
  /** Syncs tried for `applied` that missed an agent. */
  tries?: number;
  /** When to retry for the agents the last sync missed; unset when nothing is owed. */
  retryAfter?: number;
}
// One timer per process, across dev-mode module reloads.
const g = globalThis as unknown as { __rev4aPriceSchedule?: State };
const state: State = (g.__rev4aPriceSchedule ??= {});

/** The band of every scheduled vendor right now, as one comparable string. */
function bandsNow(at: Date): string {
  return Object.keys(PRICE_SCHEDULES)
    .map((vendor) => `${vendor}:${priceBandAt(`${vendor}/`, at)}`)
    .join(',');
}

function schedule(): void {
  if (state.timer) clearTimeout(state.timer);
  const next = nextPriceChange(loadModelsConfig().map((m) => m.id));
  const untilChange = next ? next.getTime() - Date.now() + AFTER_CHANGE_MS : Infinity;
  state.timer = setTimeout(check, Math.max(1_000, Math.min(CHECK_MS, untilChange)));
  state.timer.unref?.();
}

/** Write `bands` into every agent; on a miss, owe a retry until MAX_TRIES. */
function sync(bands: string): void {
  let ok = false;
  let summary = '';
  try {
    const outcome = syncAllAgents();
    ok = outcome.ok;
    summary = outcome.summary;
  } catch (e) {
    summary = (e as Error).message;
  }
  state.applied = bands;
  if (ok) {
    state.tries = 0;
    state.retryAfter = undefined;
    console.log(`[rev4a] Price band now ${bands}: ${summary}`);
    return;
  }
  state.tries = (state.tries ?? 0) + 1;
  if (state.tries < MAX_TRIES) {
    state.retryAfter = Date.now() + RETRY_MS;
    console.warn(`[rev4a] Price band now ${bands}, sync incomplete: ${summary} Retrying in ${RETRY_MS / 60_000} min.`);
  } else {
    state.retryAfter = undefined;
    console.warn(`[rev4a] Price band now ${bands}, sync incomplete after ${state.tries} tries: ${summary} Not retried until the next change; Sync All Agents applies it sooner.`);
  }
}

function check(): void {
  try {
    const bands = bandsNow(new Date());
    const offered = loadOfferedModels().some((m) => priceScheduleFor(m.id));
    if (bands !== state.applied) {
      // A change of band: write it now, whatever retry was owed for the previous one.
      state.tries = 0;
      state.retryAfter = undefined;
      if (offered) sync(bands);
      else state.applied = bands; // nothing on offer is priced by time of day
    } else if (state.retryAfter && Date.now() >= state.retryAfter) {
      if (offered) sync(bands);
      else state.retryAfter = undefined;
    }
  } catch (e) {
    console.warn(`[rev4a] Price band check failed: ${(e as Error).message}`);
  } finally {
    try {
      schedule();
    } catch (e) {
      // Never let the chain die: check again in a minute.
      console.warn(`[rev4a] Price band check could not be scheduled: ${(e as Error).message}`);
      state.timer = setTimeout(check, CHECK_MS);
      state.timer.unref?.();
    }
  }
}

/**
 * Start the checks; called once at server start, after the startup sync. When that sync
 * reached every agent, the bands it wrote count as applied; otherwise the first check
 * (a minute later) writes them.
 */
export function startPriceScheduleSync(startupSynced: boolean): void {
  state.applied = startupSynced ? bandsNow(new Date()) : undefined;
  state.tries = 0;
  state.retryAfter = undefined;
  schedule();
}
