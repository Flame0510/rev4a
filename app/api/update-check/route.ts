import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { requireAuthJWT } from '@/lib/rev4a-auth';

// Fallback used only when package.json cannot be read — the published npm
// package name is the single source of truth, so never hardcode it elsewhere.
const FALLBACK_PKG_NAME = '@flame0510/project-aether';

/**
 * The installed package's name and version. `version` is **null when it cannot be read**
 * — never a placeholder like `0.0.0`: during `rev4a update` npm rewrites this very file,
 * and a transient read failure must not look like a version that changed.
 */
function getPackageInfo(): { version: string | null; name: string } {
  // cwd first (systemd sets WorkingDirectory), then relative to this module: a global
  // install started from elsewhere still finds its own package.json.
  const candidates = [join(process.cwd(), 'package.json'), join(__dirname, '..', '..', '..', 'package.json')];
  for (const pkgPath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown; name?: unknown };
      const version = typeof parsed.version === 'string' && parsed.version ? parsed.version : null;
      const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : FALLBACK_PKG_NAME;
      if (version) return { version, name };
    } catch {
      // try the next candidate
    }
  }
  return { version: null, name: FALLBACK_PKG_NAME };
}

interface CachedResult {
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number;
}

let cache: CachedResult | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * GET /api/update-check
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const pkg = getPackageInfo();
  const installed = pkg.version;
  let latest: string | null = null;
  let updateAvailable = false;

  // Nothing to compare when the installed version is unknown: answer that, rather than
  // offering an update against a placeholder.
  if (check && installed) {
    const now = Date.now();
    if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
      latest = cache.latest;
      updateAvailable = cache.updateAvailable;
    } else {
      try {
        const pkgName = pkg.name || FALLBACK_PKG_NAME;
        latest = execSync(
          `npm view ${pkgName} version --registry https://registry.npmjs.org 2>/dev/null`,
          { stdio: 'pipe', timeout: 10_000 },
        ).toString().trim();

        if (latest && latest !== installed) {
          updateAvailable = true;
        }
        cache = { latest, updateAvailable, checkedAt: now };
      } catch {
        if (cache) {
          latest = cache.latest;
          updateAvailable = cache.updateAvailable;
        }
      }
    }
  }

  return NextResponse.json({ installed, latest, updateAvailable, package: getPackageInfo().name, log: 'update.log' });
}

/**
 * POST /api/update-check
 *
 * Spawns `rev4a update` as a detached background process: it installs the latest
 * version, writes `.restart-flag` and lets `rev4a serve` restart the child (`rev4a
 * _run`) with the new binary. Nothing here has to restart anything — the update kills
 * this very process on its way in (`fuser -k <port>/tcp`), so any callback meant to run
 * after it is dead code; the CLI's own flag is the only mechanism that has to work.
 *
 * The child's output goes to `update.log` in the data directory: since the update
 * restarts this process mid-run, that file is the only record of what happened.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const { spawn } = require('child_process');
  const { join } = require('path');
  const { openSync, closeSync, appendFileSync } = require('fs');

  const dataDir = process.env.REV4A_DATA_DIR ||
    join(process.env.HOME || '/root', '.config', 'rev4a', 'data');
  const logPath = join(dataDir, 'update.log');

  let log: number | null = null;
  try {
    log = openSync(logPath, 'a');
    appendFileSync(logPath, `\n[${new Date().toISOString()}] rev4a update, started from the dashboard\n`);
  } catch {
    // Unwritable log: run the update anyway, we just lose the record.
  }

  const child = spawn('rev4a', ['update'], {
    stdio: log === null ? 'ignore' : ['ignore', log, log],
    detached: true,
    cwd: dataDir,
  });
  if (log !== null) closeSync(log);

  child.on('error', (e: Error) => {
    try { appendFileSync(logPath, `[dashboard] could not start the update: ${e.message}\n`); } catch {}
  });
  child.unref();

  return NextResponse.json({
    success: true,
    message: 'Update started. Rev4a restarts itself once the new version is installed.',
    log: 'update.log',
  });
}
