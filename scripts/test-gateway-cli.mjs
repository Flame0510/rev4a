#!/usr/bin/env node
/**
 * Tests for lib/gateway-cli.ts: the argv wrapper, and the token precedence the script
 * resolves (`/root/.agent-token` first, then the container env), run for real in `sh`
 * with the fixed path swapped for a temp file ONLY here.
 *
 *   node scripts/test-gateway-cli.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gw from '../lib/gateway-cli.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

test('the token snippet is the entrypoint precedence, verbatim', () => {
  assert.equal(
    gw.GATEWAY_TOKEN_SNIPPET,
    'if [ -f /root/.agent-token ]; then OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]"); export OPENCLAW_GATEWAY_TOKEN; fi',
  );
});

test('the argv keeps every argument positional', () => {
  const argv = gw.gatewayCliArgv(['cron', 'remove', 'a b; rm -rf /']);
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
  assert.equal(argv[3], 'sh');
  assert.deepEqual(argv.slice(4), ['cron', 'remove', 'a b; rm -rf /']);
  assert.ok(!argv[2].includes('rm -rf'), 'argument interpolated into the script');
  assert.equal(argv[2], 'export OPENCLAW_GATEWAY_PORT=3000; ' + gw.GATEWAY_TOKEN_SNIPPET + '; exec openclaw "$@"');
});

test('port null leaves the address to the caller', () => {
  const script = gw.gatewayCliArgv(['secrets', 'reload'], { port: null })[2];
  assert.ok(!script.includes('OPENCLAW_GATEWAY_PORT'));
  assert.equal(script, gw.GATEWAY_TOKEN_SNIPPET + '; exec openclaw "$@"');
});

test('a shell script gets the token resolution first', () => {
  assert.equal(gw.gatewayShellScript('openclaw x'), gw.GATEWAY_TOKEN_SNIPPET + '; openclaw x');
});

// Run the script for real: `openclaw` is a stub that prints the token it sees.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcli-'));
try {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'openclaw'), '#!/bin/sh\nprintf "%s|%s|%s" "$OPENCLAW_GATEWAY_TOKEN" "$OPENCLAW_GATEWAY_PORT" "$*"\n', { mode: 0o755 });
  const tokenFile = path.join(dir, 'agent-token');
  const run = (script, env) => spawnSync('sh', ['-c', script.split('/root/.agent-token').join(tokenFile), 'sh', 'cron', 'list'], {
    encoding: 'utf8', env: { PATH: bin + path.delimiter + process.env.PATH, ...env },
  }).stdout;

  test('the file token wins over the container env', () => {
    fs.writeFileSync(tokenFile, 'file-token\nignored\n');
    assert.equal(run(gw.gatewayCliScript(3000), { OPENCLAW_GATEWAY_TOKEN: 'env-token' }), 'file-token|3000|cron list');
  });

  test('without the file the container env is used', () => {
    fs.rmSync(tokenFile);
    assert.equal(run(gw.gatewayCliScript(null), { OPENCLAW_GATEWAY_TOKEN: 'env-token' }), 'env-token||cron list');
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
