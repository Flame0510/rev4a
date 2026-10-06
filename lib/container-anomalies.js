'use strict';

/**
 * Container alarms for the daemon: too many processes, or memory held near Docker's total.
 * Pure — no I/O, the clock is passed in. The detector keeps the streaks and the cooldown;
 * the daemon only writes what `observe` returns.
 */

const PIDS_THRESHOLD = 1000;
const PIDS_SAMPLES = 2;
const MEMORY_PERCENT = 90;
const MEMORY_SAMPLES = 5;
const COOLDOWN_MS = 60 * 60 * 1000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function createContainerAnomalyDetector(options = {}) {
  const cooldownMs = isNum(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : COOLDOWN_MS;
  /** container -> { pids: streak, memory: streak } */
  const streaks = new Map();
  /** `<metric>:<container>` -> time of the last event */
  const lastFired = new Map();

  // The cooldown is only stamped by markRecorded, after the caller really wrote the event:
  // a failed write leaves the alert due, and it fires again on the next pass.
  function fire(out, nowMs, metric, container, values, threshold, message) {
    const key = `${metric}:${container}`;
    const last = lastFired.get(key);
    if (last !== undefined && nowMs - last < cooldownMs) return;
    out.push({ key, metric, container, values, threshold, message });
  }

  /** Feed one successful sample; returns the anomalies due now. Starts no cooldown: call markRecorded after each write. */
  function observe(sample, nowMs) {
    const out = [];
    const rows = sample && Array.isArray(sample.rows) ? sample.rows : [];
    const total = sample && sample.host ? sample.host.memTotalMb : null;
    const hasTotal = isNum(total) && total > 0;
    const seen = new Set();

    for (const row of rows) {
      if (!row || typeof row.container !== 'string' || row.container === '') continue;
      const name = row.container;
      // One row per container per sample counts once: a duplicate must not advance the streak twice.
      if (seen.has(name)) continue;
      seen.add(name);
      const s = streaks.get(name) || { pids: 0, memory: 0 };
      streaks.set(name, s);

      if (isNum(row.pids) && row.pids >= PIDS_THRESHOLD) {
        s.pids += 1;
        if (s.pids >= PIDS_SAMPLES) {
          fire(out, nowMs, 'container_pids', name, [row.pids], PIDS_THRESHOLD,
            `Container ${name}: ${row.pids} processes for ${PIDS_SAMPLES} consecutive samples`);
        }
      } else {
        s.pids = 0;
      }

      // mem_mb / total >= 90 %, compared without a division so the threshold is exact.
      // A product that overflows is bad data, never an alarm (Infinity >= Infinity is true).
      const memLeft = hasTotal && isNum(row.mem_mb) ? row.mem_mb * 100 : NaN;
      const memRight = hasTotal ? MEMORY_PERCENT * total : NaN;
      if (Number.isFinite(memLeft) && Number.isFinite(memRight) && memLeft >= memRight) {
        s.memory += 1;
        if (s.memory >= MEMORY_SAMPLES) {
          const pct = Math.round((row.mem_mb / total) * 1000) / 10;
          fire(out, nowMs, 'container_memory', name, [pct], MEMORY_PERCENT,
            `Container ${name}: memory ${pct}% of Docker's ${Math.round(total)} MB for ${MEMORY_SAMPLES} consecutive samples`);
        }
      } else {
        s.memory = 0;
      }
    }

    // A container missing from this sample loses its streaks; nothing is kept for one gone for good.
    for (const name of [...streaks.keys()]) if (!seen.has(name)) streaks.delete(name);
    // A cooldown that has run out carries no information any more.
    for (const [key, at] of lastFired) if (nowMs - at >= cooldownMs) lastFired.delete(key);
    return out;
  }

  /** The event for `key` was written at nowMs: start its cooldown. */
  function markRecorded(key, nowMs) {
    lastFired.set(key, nowMs);
  }

  return { observe, markRecorded };
}

module.exports = { createContainerAnomalyDetector, PIDS_THRESHOLD, MEMORY_PERCENT, COOLDOWN_MS };
