'use strict';

/**
 * System packages an agent installed with apt (FEAT-14). Pure helpers, no I/O: shared by the
 * route (through lib/agent-packages.d.ts) and daemon.js.
 *
 * The files are written inside the agent container by the image (`rev4a-apt` and
 * `rev4a-packages-restore`), so their contents are untrusted: everything is parsed
 * defensively, capped, and meant to be shown as plain text only.
 */

const STATES = ['running', 'ok', 'partial', 'failed', 'nothing-to-do'];
const MAX_TEXT_CHARS = 200;
const MAX_STATUS_ENTRIES = 500;
const MAX_PACKAGES = 2000;
/** Larger inputs are cut before parsing (the callers cap the exec output as well). */
const MAX_INPUT_CHARS = 1024 * 1024;

const clip = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT_CHARS);

function names(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (out.length >= MAX_STATUS_ENTRIES) break;
    if (typeof v !== 'string') continue;
    const s = clip(v);
    if (s) out.push(s);
  }
  return out;
}

function failures(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (out.length >= MAX_STATUS_ENTRIES) break;
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.error !== 'string') continue;
    const name = clip(v.name);
    if (name) out.push({ name, error: clip(v.error) });
  }
  return out;
}

/**
 * The content of packages-status.json as `{ at, state, restored, versionChanged, failed }`,
 * or null when it is not JSON, not an object, has no known state or no usable `at`.
 */
function parseStatus(text) {
  let v;
  try { v = JSON.parse(String(text ?? '').slice(0, MAX_INPUT_CHARS)); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.state !== 'string' || !STATES.includes(v.state)) return null;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) && v.at >= 0 ? Math.floor(v.at) : null;
  if (at === null) return null;
  return {
    at,
    state: v.state,
    restored: names(v.restored),
    versionChanged: names(v.versionChanged),
    failed: failures(v.failed),
  };
}

/** The content of packages.txt (`name=version` per line) as `[{ name, version }]`. */
function parsePackageList(text) {
  const out = [];
  for (const line of String(text ?? '').slice(0, MAX_INPUT_CHARS).split('\n')) {
    if (out.length >= MAX_PACKAGES) break;
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    const version = s.slice(i + 1).trim();
    if (!name || !version || name.length > MAX_TEXT_CHARS || version.length > MAX_TEXT_CHARS) continue;
    if (/[\u0000-\u001f\u007f\s]/.test(name) || /[\u0000-\u001f\u007f]/.test(version)) continue;
    out.push({ name, version });
  }
  return out;
}

/** One alert per (container, restore run): the same `at` of the same container is the same run. */
function statusAlertKey(agent, status) {
  return `${String(agent)}@${status && typeof status.at === 'number' ? status.at : 'none'}`;
}

/**
 * The restore script records a pseudo-entry named `*` when it timed out or exited unexpectedly:
 * that is the run failing, not a package. Splits `failed` into the real packages and the run's
 * error (null when there is none; '' when the entry carried no text).
 */
function splitFailed(status) {
  const failed = status && Array.isArray(status.failed) ? status.failed : [];
  const packages = failed.filter((f) => f.name !== '*');
  const run = failed.find((f) => f.name === '*');
  return { packages, runError: run ? run.error : null };
}

/** The alert text for a failed or partial run. */
function failureMessage(container, status) {
  const { packages, runError } = splitFailed(status);
  const names = packages.map((f) => f.name);
  const parts = [];
  if (names.length) parts.push(`${names.length} system package(s) could not be reinstalled: ${names.join(', ')}`);
  if (runError !== null) parts.push(`the restore did not finish${runError ? `: ${runError}` : ''}`);
  if (!parts.length) parts.push('the last restore did not complete');
  return `Container ${container}: ${parts.join('; ')}`;
}

module.exports = { splitFailed, failureMessage, STATES, MAX_TEXT_CHARS, MAX_STATUS_ENTRIES, MAX_PACKAGES, parseStatus, parsePackageList, statusAlertKey };
