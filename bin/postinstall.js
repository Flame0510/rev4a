#!/usr/bin/env node
/**
 * Post-install hook: build Next.js app if .next doesn't exist.
 *
 * Skipped when REV4A_SKIP_POSTINSTALL_BUILD is set: CI and the release workflow run
 * `npm run build` as an explicit step, and a second build here would run before every
 * other check and swallow its own failure.
 */
const { existsSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const NEXT_DIR = join(ROOT, '.next');

if (!process.env.REV4A_SKIP_POSTINSTALL_BUILD && !existsSync(NEXT_DIR)) {
  try {
    const { execSync } = require('child_process');
    console.log('[rev4a] Building dashboard… (one-time, may take a minute)');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
    console.log('[rev4a] Build complete.');
  } catch (e) {
    console.error('[rev4a] Build failed. Run "rev4a build" to retry.');
  }
}
