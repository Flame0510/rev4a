'use strict';

/**
 * Server-only. Kept out of lib/env-file.js on purpose: that file is also bundled into the browser
 * (the Config page imports RUNTIME_ONLY_ENV_KEYS), where node:fs and node:child_process do not exist
 * and the page crashed on load (seen live 2026-11-18).
 */
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { dirname } = require('node:path');

/** Coordinate short read-modify-write operations across processes without a sidecar file. */
async function withFileDirectoryLock(file, operation, io = fs) {
  const directory = dirname(file);
  const handle = await io.open(directory, 'r');
  try {
    await new Promise((resolve, reject) => {
      // flock locks the open file description shared by this process and the child.
      const child = spawn('flock', ['--exclusive', '--timeout', '20', '0'], {
        stdio: [handle.fd, 'ignore', 'ignore'],
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not acquire the lock for ${directory}.`)));
    });
    return await operation();
  } finally {
    await handle.close();
  }
}

module.exports = { withFileDirectoryLock };
