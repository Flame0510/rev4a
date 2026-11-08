'use strict';

/**
 * Validate a key before writing it as `KEY=value`. Only what would break the line format is
 * refused (empty, '=', whitespace, control characters, a leading '#'); legacy keys such as
 * `VENDOR.OPTION` stay valid, because the Config page sends every stored key back on save.
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
 * Disable loader controls written in .env (an install hit by the setup injection before this
 * release, or an operator who put NODE_OPTIONS there). Next.js loads .env itself, for the build
 * and the server, so filtering the launcher's copy is not enough: the line is commented out in
 * the file. Idempotent; returns the disabled key names (values are never logged).
 */
function disableLoaderEnvLines(content) {
  const disabled = [];
  const lines = content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim().replace(/^export\s+/, '');
    if (!isLoaderEnvKey(key)) return line;
    disabled.push(key);
    return `# Disabled by Rev4a: loader settings are not read from .env (set them in the service environment): ${trimmed}`;
  });
  return { content: lines.join('\n'), disabled };
}

module.exports = { disableLoaderEnvLines, assertEnvKey, assertEnvValue, isLoaderEnvKey, stripUninheritedLoaderEnv };
