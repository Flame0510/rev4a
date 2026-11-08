#!/usr/bin/env node
/** Offline security-header and npm file-rule checks; no server or npm subprocess. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import nextConfig from '../next.config.mjs';

const root = new URL('../', import.meta.url);

test('every dashboard page and API receives SAMEORIGIN framing protection', async () => {
  const rules = await nextConfig.headers();
  const global = rules.find((rule) => rule.source === '/:path*');
  assert.ok(global, 'The rule must cover all paths');
  assert.equal(global.has, undefined, 'Do not limit the rule to selected requests');
  assert.equal(global.missing, undefined, 'Do not exempt requests from framing protection');
  assert.deepEqual(global.headers, [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }]);
});

test('npm excludes tests and fixtures while retaining every other script', () => {
  const { files } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(files.includes('scripts/'), 'Keep existing and future runtime scripts included');
  assert.deepEqual(files.filter((rule) => rule.startsWith('!')), [
    '!scripts/test-*',
    '!scripts/fixtures/',
  ], 'Only tests and fixtures may be excluded');

  // The directory inclusion and these two exclusions retain every non-test file,
  // including nested helpers. Check the critical runtime and package-check inputs too.
  const scripts = readdirSync(new URL('scripts/', root), { recursive: true })
    .map((file) => String(file).replaceAll('\\', '/'));
  for (const file of [
    'backup.sh', 'restore.sh', 'docker/traefik/docker-compose.yml',
    'docker/traefik/traefik.yml', 'lib/model-upstream.mjs', 'check-package-types.mjs',
  ]) {
    assert.ok(scripts.includes(file), `${file} must exist under the included scripts directory`);
    assert.ok(!file.startsWith('test-') && !file.startsWith('fixtures/'));
  }
  for (const entry of [
    'app/', 'lib/', 'npm-shrinkwrap.json', 'tsconfig.json', 'next-env.d.ts',
  ]) {
    assert.ok(files.includes(entry), `${entry} is required by the package-path typecheck`);
  }
});
