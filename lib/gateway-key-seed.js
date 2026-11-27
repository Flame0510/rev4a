'use strict';

const fs = require('node:fs');
const { dirname } = require('node:path');
const { randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function discardFile(file) {
  try { fs.unlinkSync(file); } catch { /* preserve the original outcome */ }
}

function writePrivateFile(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, content, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    discardFile(file);
    throw err;
  }
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return undefined;
  }
}

function parseKeys(raw) {
  try {
    // Keep the BOM visible to JSON.parse and preserve number literals at their original precision.
    const keys = JSON.parse(decoder.decode(raw), (_key, value, context) => (
      typeof value === 'number' ? JSON.rawJSON(context.source) : value
    ));
    if (keys && Object.getPrototypeOf(keys) === Object.prototype) return keys;
  } catch { /* invalid UTF-8 or JSON */ }
  return undefined;
}

function hasGatewayKey(keys) {
  return typeof keys?.rev4a === 'string' && keys.rev4a.trim() !== '';
}

function skippedChanged(log) {
  log('Warning: provider-keys.json changed during startup; Gateway key not generated');
  return 'skipped-changed';
}

function seedGatewayKey(file, env = process.env, log = console.log) {
  let target;
  try {
    try {
      // Preserve symlinks to an existing key file and leave dangling links alone.
      target = fs.realpathSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT' || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw err;
    }

    if (target === undefined) {
      const keys = {};
      if (env.PROVIDER_DEEPSEEK_API_KEY) keys.deepseek = env.PROVIDER_DEEPSEEK_API_KEY;
      if (env.PROVIDER_OPENROUTER_API_KEY) keys.openrouter = env.PROVIDER_OPENROUTER_API_KEY;
      keys.rev4a = randomBytes(24).toString('hex');
      fs.mkdirSync(dirname(file), { recursive: true });
      try {
        writePrivateFile(file, JSON.stringify(keys, null, 2));
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const concurrent = readIfPresent(file);
        if (concurrent && hasGatewayKey(parseKeys(concurrent))) return 'exists';
        return skippedChanged(log);
      }
      log('Gateway key generated (provider-keys.json)');
      return 'created-file';
    }

    if (typeof process.getuid === 'function' && fs.statSync(target).uid !== process.getuid()) {
      log('Warning: provider-keys.json belongs to another user; Gateway key not generated');
      return 'skipped-error';
    }
    const original = fs.readFileSync(target);
    const keys = parseKeys(original);
    if (!keys) {
      log('Warning: provider-keys.json is not valid JSON; Gateway key not generated');
      return 'skipped-unreadable';
    }
    if (hasGatewayKey(keys)) return 'exists';
    // A directory may allow rename even when the existing file is read-only.
    fs.accessSync(target, fs.constants.W_OK);

    keys.rev4a = randomBytes(24).toString('hex');
    const tempFile = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    writePrivateFile(tempFile, JSON.stringify(keys, null, 2));
    let renamed = false;
    try {
      const current = readIfPresent(target);
      if (current?.equals(original)) {
        fs.renameSync(tempFile, target);
        renamed = true;
      }
    } finally {
      if (!renamed) discardFile(tempFile);
    }
    if (!renamed) return skippedChanged(log);
  } catch (err) {
    log(`Warning: could not write the Gateway key (${err.code || 'UNKNOWN'})`);
    return 'skipped-error';
  }

  log('Gateway key generated (provider-keys.json)');
  return 'added';
}

module.exports = { seedGatewayKey };
