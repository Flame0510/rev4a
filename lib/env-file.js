'use strict';

/** Per-process state and credentials; never configuration stored in .env. */
const RUNTIME_ONLY_ENV_KEYS = Object.freeze([
  'REV4A_SERVER_PID',
  'REV4A_STARTED_AT',
  'REV4A_RUNNING_VERSION',
  'REV4A_TERMINAL_SECRET',
  'REV4A_SETUP_CODE',
  // Published by server.js / the launcher for this boot: where the panel listens, which keys came from .env.
  'REV4A_LISTEN_STATE',
  'REV4A_DOTENV_KEYS',
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

/** Physical lines with their original CRLF, CR or LF separators retained. */
function splitEnvLines(content) {
  return (content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []).filter(Boolean);
}

/**
 * Read dotenv assignments with the syntax used by @next/env's bundled dotenv parser.
 * Quotes protect '#'; unquoted comments and outer whitespace are removed, double-quoted
 * \\n/\\r are decoded, CRLF/CR become LF, and the last assignment wins (even when empty).
 * Legacy operator key names remain accepted, as in the launcher before this reader.
 * This reads file values only: process-env precedence and Next's $ expansion are separate.
 */
function parseEnvValues(content) {
  const values = Object.create(null);
  // Mirror dotenv's LINE regex deliberately (with legacy key names), including its
  // backtracking cost on long runs of blank lines; @next/env is the parsing reference.
  const assignments = /^\s*(?:export\s+)?([^\s=#][^\s=]*?)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;
  const normalized = content.replace(/\r\n?/g, '\n');
  for (const match of normalized.matchAll(assignments)) {
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    values[match[1]] = value;
  }
  return values;
}

/** Undefined means no assignment; an explicit empty assignment returns ''. */
function readEnvValue(content, key) {
  return parseEnvValues(content)[key];
}

/**
 * Classify physical lines once, retaining their exact bytes. Only an assignment's first
 * line has a key/value; endIndex includes its quoted continuation lines. Like @next/env's
 * bundled dotenv parser, accept export, dotted keys, quoted # characters, trailing comments,
 * escaped quotes and double-quoted \\n / \\r escapes (also backtick quotes).
 */
function classifyEnvLines(content) {
  const lines = splitEnvLines(content)
    .map((text, index) => ({ text, continuation: false, endIndex: index }));
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    const match = lines[index].text.replace(/(?:\r\n|\r|\n)$/, '')
      .match(/^[^\S\r\n]*(?:export[^\S\r\n]+)?([\w.-]+)[^\S\r\n]*(?:=[^\S\r\n]*|:[^\S\r\n]+)([^\r\n]*)$/);
    if (!match) continue;
    let value = match[2].trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A closing quote may be followed by whitespace and a dotenv inline comment.
      const closing = new RegExp(`(?<!\\\\)${quote}[^\\S\\r\\n]*(?:#.*)?$`);
      while (!closing.test(value.slice(1)) && index + 1 < lines.length) {
        index++;
        lines[index].continuation = true;
        value += '\n' + lines[index].text.replace(/(?:\r\n|\r|\n)$/, '');
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
 * unterminated quoted value, a backslash before a same-kind quote, a value on the next line,
 * text after a closing quote) is parsed
 * differently by different tools, so automatic edits that remove or replace lines refuse it
 * rather than guess where a value ends (they could delete unrelated settings).
 */
function isPlainEnvFile(content) {
  for (const line of splitEnvLines(content)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?[^\s=#][^\s=]*\s*=([^\r\n]*)$/);
    if (!m) return false;
    const value = m[1].trim();
    const q = value[0];
    if (q === '"' || q === "'" || q === '`') {
      if (value.length < 2 || value[value.length - 1] !== q
        || value.slice(1, -1).includes(q) || value.includes(`\\${q}`)) return false;
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
  const text = splitEnvLines(content).map((line) => {
    const match = line.match(/^[^\S\r\n]*(?:export[^\S\r\n]+)?([\w.-]+)[^\S\r\n]*[=:]/);
    const key = match?.[1];
    if (!key || !isLoaderEnvKey(key)) return line;
    disabled.push(key);
    return `# Disabled by Rev4a: loader settings are not read from .env (set them in the service environment): ${line}`;
  });
  return { content: text.join(''), disabled };
}

/** Remove only exact runtime-key assignments, preserving all other bytes and line endings. */
function removeRuntimeEnvLines(content) {
  if (!isPlainEnvFile(content)) return { content, removed: [], skipped: true };
  const removed = [];
  const kept = splitEnvLines(content).filter((line) => {
    const key = line.match(/^\s*(?:export\s+)?([^\s=]+)\s*=/)?.[1];
    if (!RUNTIME_ONLY_ENV_KEYS.includes(key)) return true;
    removed.push(key);
    return false;
  });
  return { content: kept.join(''), removed };
}

/**
 * The text to write after `KEY=` so that Next's dotenv, the launcher and Rev4a all read back
 * exactly `value` ('$' is refused: Next's $-expansion would change it, even single-quoted). Unquoted when nothing in it is special to dotenv (no '#', which starts a
 * comment; no leading or trailing whitespace, which is trimmed; not starting with a quote,
 * which would be stripped). Otherwise single-quoted, which dotenv reads literally, when that
 * is possible (no single quote inside, not ending in a backslash). Anything else cannot be
 * represented faithfully and throws.
 */
function serializeEnvValue(key, value) {
  assertEnvValue(key, value);
  // Next.js expands `$VAR` in every .env value it loads (quotes do not stop it) and its server
  // overwrites the value the launcher passed: a '$' would silently change the value in effect.
  if (value.includes('$')) {
    const err = new TypeError(`The value for ${key} contains '$': Next.js expands it when it loads .env, so the value in effect would not be the one typed. Choose a value without '$'`);
    err.code = 'UNSAFE_ENV_VALUE';
    throw err;
  }
  // U+2028/U+2029 end a line for dotenv's multiline regex: such a value never reads back intact.
  if (/[\u2028\u2029]/.test(value)) {
    const err = new TypeError(`The value for ${key} contains a Unicode line separator (U+2028/U+2029)`);
    err.code = 'UNSAFE_ENV_VALUE';
    throw err;
  }
  if (!/#/.test(value) && value === value.trim() && !/^['"`]/.test(value)) return value;
  if (!value.includes("'") && !value.endsWith('\\')) return `'${value}'`;
  const err = new TypeError(`The value for ${key} cannot be stored in .env as typed (it combines a single quote with leading/trailing spaces, '#' or a leading quote)`);
  err.code = 'UNSAFE_ENV_VALUE';
  throw err;
}

/**
 * Apply edits to a plain .env, one physical line per assignment: replace the LAST assignment
 * of each key (the one every reader uses) and drop earlier duplicates; '' removes every
 * assignment of the key; a missing key is appended. Throws code NOT_PLAIN_ENV when the input
 * is not plain (nothing is guessed), UNSAFE_ENV_VALUE for a value that cannot be written
 * faithfully. Every other line is kept byte for byte.
 */
function applyEnvEdits(content, edits) {
  if (!isPlainEnvFile(content)) {
    const err = new Error('.env has a multi-line or unusual value: edit it by hand, Rev4a will not guess where a value ends');
    err.code = 'NOT_PLAIN_ENV';
    throw err;
  }
  let next = content;
  const newline = content.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const updated = [];
  for (const [key, value] of edits) {
    assertEnvKey(key);
    const text = value === '' ? '' : serializeEnvValue(key, value);
    const lines = splitEnvLines(next);
    const matches = lines.map((line) => line.match(/^\s*(?:export\s+)?([^\s=]+)\s*=/)?.[1] === key);
    const index = matches.lastIndexOf(true);
    if (index === -1) {
      if (value === '') continue;
      if (lines.length && !/[\r\n]$/.test(lines[lines.length - 1])) lines[lines.length - 1] += newline;
      lines.push(`${key}=${text}${newline}`);
    } else {
      const ending = lines[index].match(/(?:\r\n|\r|\n)$/)?.[0] ?? '';
      for (let i = index; i >= 0; i--) {
        if (!matches[i]) continue;
        if (i === index && value !== '') lines[i] = `${key}=${text}${ending}`;
        else lines.splice(i, 1);
      }
    }
    next = lines.join('');
    updated.push(key);
  }
  if (!isPlainEnvFile(next)) {
    const err = new TypeError('This value cannot be stored safely in .env');
    err.code = 'UNSAFE_ENV_VALUE';
    throw err;
  }
  return { content: next, updated };
}

/** A value read from one .env line: trimmed, surrounding matching quotes removed (as dotenv does for these files). */
function unquoteEnvValue(raw) {
  const v = String(raw ?? '').trim();
  return /^(['"`]).*\1$/.test(v) && v.length >= 2 ? v.slice(1, -1) : v;
}

/** True when a plain .env has an assignment of key (any separator, `export`, spaces around '='). */
function hasEnvAssignment(content, key) {
  return splitEnvLines(content).some((line) => line.match(/^\s*(?:export\s+)?([^\s=]+)\s*=/)?.[1] === key);
}

module.exports = { parseEnvValues, readEnvValue, hasEnvAssignment, serializeEnvValue, applyEnvEdits, unquoteEnvValue, RUNTIME_ONLY_ENV_KEYS, splitEnvLines, isPlainEnvFile, classifyEnvLines, removeRuntimeEnvLines, disableLoaderEnvLines, assertEnvKey, assertEnvValue, isLoaderEnvKey, stripUninheritedLoaderEnv };
