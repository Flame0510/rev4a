#!/usr/bin/env node
/**
 * Tests for how the agent image hands the token to the gateway (SEC-13) and for the
 * multi-arch publishing workflow (IMG-2). No Docker, no network. Run
 *
 *   node scripts/test-gateway-auth-entrypoint.mjs
 *
 * agent-templates/base-image/rev4a-gateway-auth decides between the environment (no
 * gateway.auth in openclaw.json) and --token (a config that sets its own auth, or one
 * that cannot be read). The entrypoint wiring and the workflow are checked as text.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const helper = path.join(root, 'agent-templates/base-image/rev4a-gateway-auth');
const tmp = mkdtempSync(path.join(tmpdir(), 'rev4a-gwauth-'));
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
function decide(content) {
  const file = path.join(tmp, 'openclaw.json');
  if (content === null) rmSync(file, { force: true }); else writeFileSync(file, content);
  return execFileSync(process.execPath, [helper], { env: { ...process.env, REV4A_OPENCLAW_CONFIG: file }, encoding: 'utf8' }).trim();
}

test('no config file: environment', () => assert.equal(decide(null), 'env'));
test('config without gateway.auth: environment', () => assert.equal(decide('{"gateway":{"mode":"local"}}'), 'env'));
test('empty gateway.auth object: environment', () => assert.equal(decide('{"gateway":{"auth":{}}}'), 'env'));
test('auth.mode "token" alone: environment', () => assert.equal(decide('{"gateway":{"auth":{"mode":"token"}}}'), 'env'));
test('gateway.auth.token set: --token', () => assert.equal(decide('{"gateway":{"auth":{"token":"x"}}}'), 'token configured'));
test('gateway.auth.password set: --token', () => assert.equal(decide('{"gateway":{"auth":{"password":"x"}}}'), 'token configured'));
test('non-token auth mode: --token', () => assert.equal(decide('{"gateway":{"auth":{"mode":"password"}}}'), 'token configured'));
test('unreadable config: --token', () => assert.equal(decide('{ not json'), 'token unreadable'));
test('config that is not an object: environment', () => assert.equal(decide('null'), 'env'));
test('the helper never prints a token', () => {
  assert.ok(!decide('{"gateway":{"auth":{"token":"SECRET-VALUE"}}}').includes('SECRET'));
});

const entry = readFileSync(path.join(root, 'agent-templates/base-image/entrypoint.sh'), 'utf8');
test('entrypoint: env path exports the token and execs without --token', () => {
  const envBranch = entry.slice(entry.indexOf('  env)'), entry.indexOf('"token configured")'));
  assert.match(envBranch, /export OPENCLAW_GATEWAY_TOKEN="\$AGENT_TOKEN"/);
  assert.match(envBranch, /exec openclaw gateway [^\n]*--allow-unconfigured/);
  assert.ok(!envBranch.includes('--token'));
});
test('entrypoint: fallback keeps --token', () => assert.match(entry, /\nexec openclaw gateway [^\n]*--token "\$\{AGENT_TOKEN\}"/));
test('entrypoint: logs never contain the token variable', () => {
  for (const line of entry.split('\n')) if (/^\s*echo "\[entrypoint\]/.test(line)) assert.ok(!line.includes('AGENT_TOKEN'), line);
});
test('Dockerfile installs the helper', () => {
  const d = readFileSync(path.join(root, 'agent-templates/base-image/Dockerfile'), 'utf8');
  assert.match(d, /COPY rev4a-gateway-auth \/usr\/local\/sbin\/rev4a-gateway-auth/);
});

const wf = readFileSync(path.join(root, '.github/workflows/build-agent-image.yml'), 'utf8');
test('workflow builds both platforms natively', () => {
  assert.match(wf, /platform: linux\/amd64\s+runner: ubuntu-latest/);
  assert.match(wf, /platform: linux\/arm64\s+runner: ubuntu-24\.04-arm/);
  assert.ok(!/setup-qemu/.test(wf));
});
test('workflow pushes by digest and merges after the build', () => {
  assert.match(wf, /push-by-digest=true,name-canonical=true,push=true/);
  assert.match(wf, /merge:\s+needs: \[prepare, build\]/);
  assert.match(wf, /docker buildx imagetools create \$TAGARGS \$SOURCES/);
  assert.match(wf, /imagetools inspect/);
});
test('workflow keeps the revision label on both platforms and the tag rules', () => {
  assert.match(wf, /IMAGE_REVISION=\$\{\{ needs\.prepare\.outputs\.revision \}\}/);
  assert.match(wf, /\$\{VERSION\}-\$\{GITHUB_SHA::7\}/);
  assert.match(wf, /promote_latest/);
});
test('workflow retag is multi-arch safe', () => {
  assert.match(wf, /imagetools create -t "\$\{BASE\}:\$\{V\}" "\$\{BASE\}:latest"/);
  assert.ok(!/docker pull/.test(wf));
});

test('workflow validates the whole version string and keeps step outputs out of script text', () => {
  // grep -E matches line by line: a second line would pass. Bash [[ =~ ]] checks the whole string.
  assert.ok(!/grep -Eq/.test(wf));
  assert.equal((wf.match(/\[\[ ! "\$(VERSION|V)" =~ \^\[0-9\]\+/g) ?? []).length, 2);
  assert.equal((wf.match(/== \*"\$NL"\*/g) ?? []).length, 2);
  // No ${{ }} expression inside a run: script (only env:, with: and similar keys carry them).
  const scripts = wf.split(/\n(?=\s*- name:)/).flatMap((step) => {
    const m = step.match(/\n\s+run: \|?\n?([\s\S]*?)(?=\n\s{6,8}[a-z-]+:|$)/);
    return m ? [m[1]] : [];
  });
  for (const body of scripts) assert.ok(!/\$\{\{/.test(body), `expression in a run script: ${body.slice(0, 80)}`);
});

rmSync(tmp, { recursive: true, force: true });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
