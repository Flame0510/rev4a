'use strict';

/**
 * Optional memory limit of an agent container. Pure helpers, no I/O: shared by the routes
 * (through lib/agent-memory-limit.d.ts), the container rebuild and daemon.js.
 *
 * A Docker memory limit kills, it does not slow down, so a limit is always the operator's
 * choice. The swap is always set equal to the limit: the limit is the total the container
 * can use, with no extra swap.
 */

const MIN_LIMIT_MB = 256;
const MAX_LIMIT_MB = 1048576; // 1 TiB
const BYTES_PER_MB = 1024 * 1024;

/**
 * A limit typed or sent as a number or a numeric string, in MB.
 * Returns an integer in [MIN_LIMIT_MB, MAX_LIMIT_MB], or null for "no limit"
 * (null, undefined, '', 0). Throws an Error with an English message for anything else.
 */
function parseLimitMb(input) {
  if (input === null || input === undefined) return null;
  let n;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Memory limit must be a number of MB');
    n = input;
  } else if (typeof input === 'string') {
    const s = input.trim();
    if (s === '') return null;
    if (!/^-?\d+$/.test(s)) throw new Error('Memory limit must be a whole number of MB, without units');
    n = Number(s);
  } else {
    throw new Error('Memory limit must be a number of MB');
  }
  if (!Number.isInteger(n)) throw new Error('Memory limit must be a whole number of MB');
  if (n === 0) return null;
  if (n < 0) throw new Error('Memory limit must not be negative');
  if (n < MIN_LIMIT_MB) throw new Error(`Memory limit must be at least ${MIN_LIMIT_MB} MB`);
  if (n > MAX_LIMIT_MB) throw new Error(`Memory limit must be at most ${MAX_LIMIT_MB} MB`);
  return n;
}

/** Sizes offered by the picker, in MB (binary: 1 GB = 1024 MB). */
const MEMORY_PRESETS_MB = [1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384];

/**
 * A size typed in GB ("2.5", or "2,5") to integer MB (2560), rounded. Throws an English error
 * that speaks in GB for an empty or non-numeric text or a size out of range.
 */
function parseGbInput(text) {
  const raw = typeof text === 'string' ? text.trim() : typeof text === 'number' ? String(text) : '';
  const s = /^[^,]*,[^,.]*$/.test(raw) ? raw.replace(',', '.') : raw;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter a size in GB, like 2 or 2.5');
  const mb = Math.round(Number(s) * 1024);
  if (!(mb >= MIN_LIMIT_MB)) throw new Error(`Size must be at least ${MIN_LIMIT_MB / 1024} GB`);
  if (!(mb <= MAX_LIMIT_MB)) throw new Error(`Size must be at most ${MAX_LIMIT_MB / 1024} GB`);
  return mb;
}

/**
 * MB to the GB text of the custom field, exact: MB / 1024 has at most 10 decimals, so
 * parseGbInput(mbToGbText(mb)) === mb. 2560 -> '2.5', 2048 -> '2', 277 -> '0.2705078125'.
 */
function mbToGbText(mb) {
  if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return '';
  return (mb / 1024).toFixed(10).replace(/\.?0+$/, '');
}

/** MB to bytes. */
function mbToBytes(mb) {
  return mb * BYTES_PER_MB;
}

/** Bytes to whole MB, rounded down. null for anything that is not a positive number. */
function bytesToMb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.floor(bytes / BYTES_PER_MB);
}

/** 'none', '512 MB', '1 GB', '1.5 GB'. */
function formatLimit(mb) {
  if (mb === null || mb === undefined || typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return 'none';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = Math.round((mb / 1024) * 10) / 10;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/**
 * The `docker run` flags that carry a limit read from a container inspect
 * (HostConfig.Memory, HostConfig.MemorySwap). A limit of 0 is "none" and emits nothing;
 * swap emits only when > 0 or -1 (unlimited swap).
 */
function limitArgs(memoryBytes, memorySwapBytes) {
  const out = [];
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
  if (valid(memoryBytes) && memoryBytes > 0) out.push('--memory', String(memoryBytes));
  if (valid(memorySwapBytes) && (memorySwapBytes > 0 || memorySwapBytes === -1)) out.push('--memory-swap', String(memorySwapBytes));
  return out;
}

/**
 * The flags a rebuild passes. `override` undefined: carry what the inspect says; null:
 * none at all (limit removal); a number of MB: that limit, swap equal.
 */
function rebuildLimitArgs(hostConfig, override) {
  if (override === null) return [];
  if (override !== undefined) {
    const bytes = mbToBytes(override);
    return limitArgs(bytes, bytes);
  }
  const hc = hostConfig || {};
  return limitArgs(hc.Memory, hc.MemorySwap);
}

/**
 * Docker `oom` events to one anomaly each, for containers carrying AGENT_ID.
 * `limitsMb` maps a container name to its limit in MB (optional). De-duplicated by
 * (container, time); malformed events are ignored.
 */
function oomEventsToAnomalies(events, limitsMb) {
  const limits = limitsMb && typeof limitsMb === 'object' ? limitsMb : {};
  const seen = new Set();
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.Type !== 'container' || ev.Action !== 'oom') continue;
    const attrs = ev.Actor && typeof ev.Actor === 'object' ? ev.Actor.Attributes : null;
    if (!attrs || typeof attrs !== 'object') continue;
    if (typeof attrs.AGENT_ID !== 'string' || attrs.AGENT_ID === '') continue;
    const container = typeof attrs.name === 'string' ? attrs.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) : '';
    if (!container) continue;
    const stamp = typeof ev.timeNano === 'number' && Number.isFinite(ev.timeNano) ? ev.timeNano
      : typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : null;
    if (stamp === null) continue;
    const key = `${container}@${stamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = limits[container];
    const limitMb = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    out.push({
      key,
      container,
      time: typeof ev.time === 'number' ? ev.time : null,
      limitMb,
      values: [limitMb],
      message: `Container ${container}: a process was killed, out of memory (limit ${formatLimit(limitMb)})`,
    });
  }
  return out;
}

/**
 * Docker's /events answer: one JSON object per line (nothing when there are none).
 * Lines that are not an object are skipped.
 */
function parseEventStream(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v);
    } catch { /* skip a torn line */ }
  }
  return events;
}

module.exports = {
  MIN_LIMIT_MB,
  MAX_LIMIT_MB,
  MEMORY_PRESETS_MB,
  parseGbInput,
  mbToGbText,
  parseLimitMb,
  mbToBytes,
  bytesToMb,
  formatLimit,
  limitArgs,
  rebuildLimitArgs,
  oomEventsToAnomalies,
  parseEventStream,
};
