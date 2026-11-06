'use strict';

/**
 * The channel-pairing SDK is a package export, not a globally resolvable bare
 * import from `node -e`. Resolve it from the installed OpenClaw package itself.
 * The package root parameter lets the same script run against offline fixtures.
 */
function buildPairingStoreScript(packageRoot = '/usr/local/lib/node_modules/openclaw') {
  return COMMAND_BODY.replace('__REV4A_PAIRING_PACKAGE_ROOT__', () => JSON.stringify(packageRoot));
}

// Keep executable container code literal: Next's bundler must not rewrite its require calls.
const COMMAND_BODY = String.raw`
(async (packageRoot) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const [op, channel, entry] = process.argv.slice(1);
  if (!['read', 'remove', 'clear'].includes(op)) {
    console.log('pair:error Unknown pairing store operation');
    return;
  }
  if (!/^[a-z0-9_-]+$/.test(channel ?? '') || (op === 'remove' && typeof entry !== 'string')) {
    console.log('pair:error Invalid pairing store arguments');
    return;
  }

  let phase = 'load';
  try {
    let read;
    let remove;
    if (op !== 'remove') {
      const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
      let sdkPath;
      try {
        sdkPath = installedRequire.resolve('openclaw/plugin-sdk/channel-pairing');
      } catch (e) {
        // Old builds have no public reader. A broken installed public reader is
        // an error, not permission to silently retry through private code.
        if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(e.code)) throw e;
      }
      if (sdkPath) {
        const sdk = await import(pathToFileURL(sdkPath).href);
        if (typeof sdk.readChannelAllowFromStore === 'function') read = sdk.readChannelAllowFromStore;
      }
    }

    // Removal is not exported by the public pairing SDK. Discover only the
    // private capability this operation needs; reads do not depend on removal.
    if ((!read && op !== 'remove') || op !== 'read') {
      const dist = path.join(packageRoot, 'dist');
      const files = fs.readdirSync(dist).filter((name) => /^pairing-store-.*\.mjs$/.test(name)).sort();
      for (const file of files) {
        const mod = await import(pathToFileURL(path.join(dist, file)).href);
        for (const value of Object.values(mod)) {
          if (typeof value !== 'function') continue;
          if (!read && op !== 'remove' && value.name === 'readChannelAllowFromStoreSync') read = value;
          if (op !== 'read' && value.name === 'removeChannelAllowFromStoreEntry') remove = value;
        }
        if ((op === 'remove' || read) && (op === 'read' || remove)) break;
      }
    }
    if ((op !== 'remove' && !read) || (op !== 'read' && !remove)) {
      console.log('pair:unsupported');
      return;
    }

    const normalize = (list) => {
      if (!Array.isArray(list)) throw new Error('Invalid allowlist');
      return list.map((item) => {
        const value = typeof item === 'string' ? item : item && typeof item === 'object'
          ? item.id ?? item.senderId ?? item.entry : undefined;
        if (typeof value !== 'string' || !value) throw new Error('Invalid allowlist entry');
        return value;
      });
    };
    const removeEntry = async (sender) => {
      const result = await remove({ channel, entry: sender });
      if (!result || typeof result.changed !== 'boolean') throw new Error('Invalid removal result');
      return result.changed;
    };
    if (op === 'read') {
      phase = 'read';
      console.log('pair:list ' + JSON.stringify(normalize(await read(channel))));
    } else if (op === 'remove') {
      phase = 'remove';
      console.log(await removeEntry(entry) ? 'pair:ok' : 'pair:absent');
    } else {
      phase = 'clear';
      // Validate every entry before the first write; re-read after the writes so
      // a partial or ineffective removal never certifies a clean allowlist.
      const entries = normalize(await read(channel));
      for (const sender of entries) await removeEntry(sender);
      if (normalize(await read(channel)).length) throw new Error('Allowlist still populated');
      console.log('pair:ok');
    }
  } catch {
    // Native exceptions may contain configuration, tokens or command arguments.
    // Keep those out of responses and logs, including after a partial clear.
    const errors = {
      load: 'Could not load the pairing store capability',
      read: 'Could not read the approved senders list',
      remove: 'Could not confirm the approved sender removal',
      clear: 'Could not confirm the allowlist was cleared; some senders may already have been removed',
    };
    console.log('pair:error ' + errors[phase]);
  }
})(__REV4A_PAIRING_PACKAGE_ROOT__);
`;

/** A killed command, malformed list or conflicting terminal lines is not success. */
function parsePairingStoreOutput(output, op) {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('pair:'));
  if (lines.length !== 1) return { status: 'error', error: 'Pairing store command did not return a complete result' };
  const line = lines[0];
  if (line === 'pair:unsupported') return { status: 'unsupported' };
  if (line.startsWith('pair:error ')) return { status: 'error', error: line.slice('pair:error '.length) };
  if (op === 'read' && line.startsWith('pair:list ')) {
    try {
      const entries = JSON.parse(line.slice('pair:list '.length));
      if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string' || !entry)) throw new Error('Invalid list');
      return { status: 'ok', entries };
    } catch {
      return { status: 'error', error: 'Could not read the approved senders list' };
    }
  }
  if (op !== 'read' && line === 'pair:ok') return { status: 'ok' };
  if (op === 'remove' && line === 'pair:absent') return { status: 'absent' };
  return { status: 'error', error: 'Pairing store command returned an unexpected result' };
}

module.exports = {
  buildPairingStoreScript,
  PAIRING_STORE_SCRIPT: buildPairingStoreScript(),
  parsePairingStoreOutput,
};
