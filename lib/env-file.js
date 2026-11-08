'use strict';

/** Per-process state and credentials; never configuration stored in .env. */
const RUNTIME_ONLY_ENV_KEYS = Object.freeze([
  'REV4A_SERVER_PID',
  'REV4A_STARTED_AT',
  'REV4A_RUNNING_VERSION',
  'REV4A_TERMINAL_SECRET',
  'REV4A_SETUP_CODE',
]);

/**
 * Validate a key before writing it as `KEY=value`. Only what would break the line format is
 * refused (empty, '=', whitespace, control characters, a leading '#'); legacy keys such as
 * `VENDOR.OPTION` stay valid, including requests from older Config tabs.
 */
function assertEnvKey(key) {
  if (typeof key !== 'string' || key === '' || /[=\s\0]/.test(key) || /[\x00-\x1f\x7f]/.test(key) || key.startsWith('#')) {
    throw new TypeError(`Invalid environment key: ${JSON.stringify(key)}`);
  }
}

/** Validate before interpolating a value into the line-based .env format. */
function assertEnvValue(key, value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new TypeError(`Invalid value for ${key}: must be a string without CR, LF or NUL characters`);
  }
}

/** Controls that must come only from the operator's inherited environment. */
function isLoaderEnvKey(key) {
  return ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)
    || key.startsWith('DYLD_');
}

/** Remove controls Next loaded from .env, preserving keys present at process start. */
function stripUninheritedLoaderEnv(env, inheritedKeys, warn) {
  for (const key of Object.keys(env)) {
    if (isLoaderEnvKey(key) && !inheritedKeys.has(key)) {
      delete env[key];
      warn(`Warning: skipped unsafe environment key ${key}`);
    }
  }
}

/**
 * Classify physical lines once, retaining their exact bytes. Only an assignment's first
 * line has a key/value; endIndex includes its quoted continuation lines. Like @next/env's
 * bundled dotenv parser, accept export, dotted keys, quoted # characters, trailing comments,
 * escaped quotes and double-quoted \\n / \\r escapes (also backtick quotes).
 */
function classifyEnvLines(content) {
  const lines = (content.match(/[^\n]*(?:\n|$)/g) || []).filter(Boolean)
    .map((text, index) => ({ text, continuation: false, endIndex: index }));
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    const match = lines[index].text.replace(/\r?\n$/, '')
      .match(/^[^\S\r\n]*(?:export[^\S\r\n]+)?([\w.-]+)[^\S\r\n]*(?:=[^\S\r\n]*|:[^\S\r\n]+)(.*)$/);
    if (!match) continue;
    let value = match[2].trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A closing quote may be followed by whitespace and a dotenv inline comment.
      const closing = new RegExp(`(?<!\\\\)${quote}[^\\S\\r\\n]*(?:#.*)?$`);
      while (!closing.test(value.slice(1)) && index + 1 < lines.length) {
        index++;
        lines[index].continuation = true;
        value += '\n' + lines[index].text.replace(/\r?\n$/, '');
      }
      const end = closing.exec(value.slice(1));
      if (end) value = value.slice(1, end.index + 1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      value = value.split('#', 1)[0].trim();
    }
    Object.assign(lines[start], { key: match[1], value, endIndex: index });
  }
  return lines;
}

/**
 * True when every line is blank, a comment, or a one-line `KEY=value` whose quoted value
 * closes on the same line. Rev4a writes only such files. Anything else (a multi-line or
 * unterminated quoted value, a value on the next line, text after a closing quote) is parsed
 * differently by different tools, so automatic edits that remove or replace lines refuse it
 * rather than guess where a value ends (they could delete unrelated settings).
 */
function isPlainEnvFile(content) {
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?[^\s=#][^\s=]*\s*=(.*)$/);
    if (!m) return false;
    const value = m[1].trim();
    const q = value[0];
    if (q === '"' || q === "'" || q === '`') {
      if (value.length < 2 || value[value.length - 1] !== q || value.slice(1, -1).includes(q)) return false;
    }
  }
  return true;
}

/**
 * Disable loader controls written in .env (an install hit by the setup injection before this
 * release, or an operator who put NODE_OPTIONS there). Next.js loads .env itself, for the build
 * and the server, so filtering the launcher's copy is not enough: the line is commented out in
 * the file. Idempotent; returns the disabled key names (values are never logged).
 */
function disableLoaderEnvLines(content) {
  // Line based on purpose: it only ever comments a line out, so it is safe even inside a
  // multi-line value, and it cannot be fooled by an unterminated quote above the line.
  const disabled = [];
  const text = content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim().replace(/^export\s+/, '');
    if (!isLoaderEnvKey(key)) return line;
    disabled.push(key);
    return `# Disabled by Rev4a: loader settings are not read from .env (set them in the service environment): ${trimmed}`;
  });
  return { content: text.join('\n'), disabled };
}

/** Remove only exact runtime-key assignments, preserving all other bytes and line endings. */
function removeRuntimeEnvLines(content) {
  if (!isPlainEnvFile(content)) return { content, removed: [], skipped: true };
  const removed = [];
  const lines = classifyEnvLines(content);
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.key && RUNTIME_ONLY_ENV_KEYS.includes(line.key)) {
      removed.push(line.key);
      index = line.endIndex;
    } else kept.push(line.text);
  }
  return { content: kept.join(''), removed };
}

module.exports = { RUNTIME_ONLY_ENV_KEYS, isPlainEnvFile, classifyEnvLines, removeRuntimeEnvLines, disableLoaderEnvLines, assertEnvKey, assertEnvValue, isLoaderEnvKey, stripUninheritedLoaderEnv };
