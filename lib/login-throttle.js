'use strict';

/**
 * In-memory throttle for failed dashboard logins, keyed by client address.
 *
 * The first `freeFailures` failures inside `windowMs` cost nothing. From the next one the key is
 * locked for `baseLockMs * 2^(n - freeFailures - 1)`, capped at `maxLockMs`. n is the most failures
 * the key has had inside the window since it last went a whole window without one (its "peak"): a
 * key that keeps retrying at every unlock stays at its cap instead of sliding back to short locks
 * as old failures leave the window (with a plain sliding count, retrying every 15 minutes never
 * holds more than 4 failures in an hour, so no lock would be left). Failures older than the window
 * are forgotten; an entry with none left, and no lock running, is dropped with its peak.
 * A successful login clears the key. Counters live in this process only: a restart resets them.
 *
 * When the map is full the least recently active key without a running lock is evicted; only if
 * every key is locked, the one whose lock ends soonest. Filling the map never frees a locked key
 * while an unlocked one exists.
 *
 * Pure and clock-injectable; no timers, expired entries are dropped lazily.
 */

const DEFAULTS = {
  freeFailures: 5,
  windowMs: 60 * 60 * 1000,
  baseLockMs: 30 * 1000,
  maxLockMs: 15 * 60 * 1000,
  maxKeys: 10000,
};

// Past this many failures the lock is at its cap anyway; stop growing the list.
const MAX_TRACKED_FAILURES = 64;

function createLoginThrottle(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const freeFailures = options.freeFailures ?? DEFAULTS.freeFailures;
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const baseLockMs = options.baseLockMs ?? DEFAULTS.baseLockMs;
  const maxLockMs = options.maxLockMs ?? DEFAULTS.maxLockMs;
  const maxKeys = options.maxKeys ?? DEFAULTS.maxKeys;

  /** key -> { failures: number[], peak: number, lockedUntil: number }. Map order = least to most recent activity. */
  const entries = new Map();

  /** Drops failures that left the window; deletes the entry when nothing is left. */
  function prune(key, entry, t) {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < entry.failures.length && entry.failures[i] <= cutoff) i++;
    if (i > 0) entry.failures.splice(0, i);
    if (entry.failures.length === 0 && entry.lockedUntil <= t) {
      entries.delete(key);
      return false;
    }
    return true;
  }

  function check(key) {
    const t = now();
    const entry = entries.get(key);
    if (!entry || !prune(key, entry, t)) return { allowed: true };
    if (entry.lockedUntil > t) {
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((entry.lockedUntil - t) / 1000)) };
    }
    return { allowed: true };
  }

  function fail(key) {
    const t = now();
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key); // re-inserted below: moves it to the most recent position
      if (!prune(key, entry, t)) entry = undefined;
    }
    if (!entry) entry = { failures: [], peak: 0, lockedUntil: 0 };
    entry.failures.push(t);
    if (entry.failures.length > MAX_TRACKED_FAILURES) entry.failures.shift();
    entry.peak = Math.max(entry.peak, entry.failures.length);
    const n = entry.peak;
    if (n > freeFailures) {
      const lockMs = Math.min(maxLockMs, baseLockMs * 2 ** (n - freeFailures - 1));
      entry.lockedUntil = t + lockMs;
    }
    while (entries.size >= maxKeys) {
      if (!evictOne(t)) break;
    }
    entries.set(key, entry);
  }

  /** Evicts one entry: the least recently active without a running lock, else the lock ending soonest. */
  function evictOne(t) {
    let victim;
    let soonest;
    let soonestEnd = Infinity;
    for (const [k, e] of entries) {
      if (e.lockedUntil <= t) { victim = k; break; }
      if (e.lockedUntil < soonestEnd) { soonestEnd = e.lockedUntil; soonest = k; }
    }
    if (victim === undefined) victim = soonest;
    if (victim === undefined) return false;
    entries.delete(victim);
    return true;
  }

  function succeed(key) {
    entries.delete(key);
  }

  function size() {
    return entries.size;
  }

  return { check, fail, succeed, size };
}

module.exports = { createLoginThrottle, DEFAULTS };
