'use strict';

/**
 * In-memory throttle for failed dashboard logins, keyed by client address.
 *
 * The first `freeFailures` failures inside `windowMs` cost nothing. From the next one the key is
 * locked for `baseLockMs * 2^(n - freeFailures - 1)` (n = failures in the window), capped at
 * `maxLockMs`. Failures older than the window are forgotten. A successful login clears the key.
 * Counters live in this process only: a restart resets them.
 *
 * Pure and clock-injectable; no timers, expired entries are dropped lazily.
 */

const DEFAULTS = {
  freeFailures: 5,
  windowMs: 15 * 60 * 1000,
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

  /** key -> { failures: number[], lockedUntil: number }. Map order = least to most recent activity. */
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
    if (!entry) entry = { failures: [], lockedUntil: 0 };
    entry.failures.push(t);
    if (entry.failures.length > MAX_TRACKED_FAILURES) entry.failures.shift();
    const n = entry.failures.length;
    if (n > freeFailures) {
      const lockMs = Math.min(maxLockMs, baseLockMs * 2 ** (n - freeFailures - 1));
      entry.lockedUntil = t + lockMs;
    }
    while (entries.size >= maxKeys) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    entries.set(key, entry);
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
