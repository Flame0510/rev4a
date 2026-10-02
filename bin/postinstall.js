#!/usr/bin/env node
/**
 * Post-install hook: build Next.js app if a complete production build is absent.
 *
 * Skipped when REV4A_SKIP_POSTINSTALL_BUILD is set: CI and the release workflow run
 * `npm run build` as an explicit step, and a second build here would run before every
 * other check. A failed build must fail the install so an update cannot restart into
 * an incomplete .next directory.
 */
const { existsSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const BUILD_ID = join(ROOT, '.next', 'BUILD_ID');

if (!process.env.REV4A_SKIP_POSTINSTALL_BUILD && !existsSync(BUILD_ID)) {
  try {
    const { execSync } = require('child_process');
    console.log('[rev4a] Building dashboard… (one-time, may take a minute)');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
    if (!existsSync(BUILD_ID)) throw new Error('next build returned without a BUILD_ID');
    console.log('[rev4a] Build complete.');
  } catch (e) {
    console.error('[rev4a] Build failed. Run "rev4a build" to retry.');
    process.exitCode = 1;
  }
}
