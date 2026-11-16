'use strict';
/**
 * BUG-22: manual compaction of a session that runs on Claude through Claude Code.
 *
 * OpenClaw runs a manual compaction ("Compact" in the Control UI, `openclaw sessions compact`) as a
 * one-shot Claude Code run with bypassPermissions. Claude Code refuses that as root unless
 * `IS_SANDBOX=1` is in its environment, and an agent runs as root in its container. OpenClaw starts
 * Claude Code with `--setting-sources user`, so `/root/.claude/settings.json` (on the agent's data
 * volume) is read at every start and its `env` object is applied: Rev4a puts `IS_SANDBOX=1` there.
 * Normal turns are not affected either way.
 *
 * One implementation: `ensureSandboxEnv` is pure, and the script run in the container is built from
 * its source text. CommonJS, shared by lib/subscription-claude.ts (on connect) and daemon.js (the
 * repair for agents connected before this fix).
 */

const CLAUDE_SETTINGS_PATH = '/root/.claude/settings.json';

/**
 * Pure. `text` is the current content of settings.json, or `null` when the file does not exist.
 * Returns { result: 'ok' | 'set' | 'invalid', text }: `text` is the content to write (only for 'set').
 * An unreadable file is 'invalid' and is never overwritten. Self-contained on purpose: its source
 * text is embedded in the container script. Keep one literal source: bundlers rename functions,
 * so serializing a compiled function would lose the name the container script calls.
 */
const ENSURE_SANDBOX_ENV_SRC = String.raw`function (text) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pretty = (o) => JSON.stringify(o, null, 2) + '\n';
  if (text === null || text === undefined || String(text).trim() === '') {
    return { result: 'set', text: pretty({ env: { IS_SANDBOX: '1' } }) };
  }
  let settings;
  try {
    settings = JSON.parse(String(text));
  } catch {
    return { result: 'invalid', text: null };
  }
  if (!isObject(settings)) return { result: 'invalid', text: null };
  if (settings.env !== undefined && !isObject(settings.env)) return { result: 'invalid', text: null };
  if (settings.env && settings.env.IS_SANDBOX === '1') return { result: 'ok', text: null };
  settings.env = { ...(settings.env || {}), IS_SANDBOX: '1' };
  return { result: 'set', text: pretty(settings) };
}`;

const ensureSandboxEnv = new Function('return (' + ENSURE_SANDBOX_ENV_SRC + ');')();

/**
 * Fixed source for `node -e` in the container: nothing is interpolated at run time. Prints one JSON
 * line, `{"result":"ok"|"set"|"invalid"}` or `{"result":"error"}`, never the file content. A write
 * goes to a temp file in the same directory, renamed over the target, with the existing file's mode
 * (a new file is 0600).
 */
const ENSURE_SANDBOX_ENV_SCRIPT = `
const fs = require('fs');
const path = require('path');
const FILE = ${JSON.stringify(CLAUDE_SETTINGS_PATH)};
const ensureSandboxEnv = (${ENSURE_SANDBOX_ENV_SRC});
let out;
try {
  let current = null;
  let mode = 0o600;
  try {
    current = fs.readFileSync(FILE, 'utf8');
    mode = fs.statSync(FILE).mode & 0o777;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const r = ensureSandboxEnv(current);
  if (r.result === 'set') {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = path.join(path.dirname(FILE), '.settings.json.' + process.pid + '.tmp');
    try {
      fs.writeFileSync(tmp, r.text, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
  out = { result: r.result };
} catch {
  out = { result: 'error' };
}
process.stdout.write(JSON.stringify(out) + '\\n');
`;

/** The script's stdout as 'ok' | 'set' | 'invalid' | 'error'; null when it is not the one JSON line. */
function parseEnsureSandboxResult(stdout) {
  if (typeof stdout !== 'string') return null;
  const line = stdout.trim();
  if (!line || line.includes('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const r = parsed && typeof parsed === 'object' ? parsed.result : null;
  return r === 'ok' || r === 'set' || r === 'invalid' || r === 'error' ? r : null;
}

module.exports = {
  CLAUDE_SETTINGS_PATH,
  ENSURE_SANDBOX_ENV_SRC,
  ensureSandboxEnv,
  ENSURE_SANDBOX_ENV_SCRIPT,
  parseEnsureSandboxResult,
};
