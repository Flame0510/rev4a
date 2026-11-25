import { NextResponse } from 'next/server';
import { execSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { adoptPid, claimUpdate, CLAIM_ENV, failClaimed } from '@/lib/update-state';

// Fallback used only when package.json cannot be read — the published npm
// package name is the single source of truth, so never hardcode it elsewhere.
const FALLBACK_PKG_NAME = 'rev4a';

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
      // Recomputed against the version reading us now: `installed` is not cached, and
      // reusing the cached flag made the banner offer an update that had just been
      // installed, for up to the cache's fifteen minutes (seen right after an update).
      updateAvailable = !!latest && latest !== installed;
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
 * version and calls `rev4a restart`. The CLI writes `.restart-flag` so `rev4a serve`
 * restarts the child (`rev4a _run`) with the new binary. The server stays up through
 * install and build. The CLI fallback only signals the dashboard server if its
 * recorded PID and OS start time still match.
 *
 * The child's output goes to `update.log` in the data directory: since the update
 * restarts this process mid-run, that file is the only record of what happened.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const dataDir = join(REV4A_DATA, 'data');

  const logPath = join(dataDir, 'update.log');

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not prepare the update directory.' }, { status: 500 });
  }

  // One update at a time (two tabs, or a terminal update already running). The check and
  // the write of `starting` are one synchronous step with no await between them and
  // before anything is spawned, so two simultaneous requests cannot both pass. The pid is
  // this server's for the moment; the child's replaces it once it exists.
  const claim = randomBytes(12).toString('hex');
  const claimed = claimUpdate(dataDir, { from: getPackageInfo().version, claim, pid: process.pid });
  if (!claimed.ok) {
    return NextResponse.json({ success: false, error: 'An update is already running.' }, { status: 409 });
  }

  let log: number | null = null;
  try {
    log = openSync(logPath, 'a');
    appendFileSync(logPath, `\n[${new Date().toISOString()}] rev4a update ${claimed.state?.startedAt}, started from the dashboard\n`);
  } catch {
    // Unwritable log: run the update anyway, we just lose the record.
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('rev4a', ['update'], {
      stdio: log === null ? 'ignore' : ['ignore', log, log],
      detached: true,
      cwd: dataDir,
      // The updater recognises its own claim and does not refuse to start because of it.
      env: { ...process.env, [CLAIM_ENV]: claim },
    });
    if (log !== null) closeSync(log);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try { appendFileSync(logPath, `[dashboard] could not start the update: ${message}\n`); } catch {}
    failClaimed(dataDir, claim, `Could not start the update: ${message}`);
    return NextResponse.json({ success: false, error: 'Could not start the update.' }, { status: 500 });
  }
  child.unref();

  // The updater exists: its pid replaces ours, but only if the state still carries this
  // claim. A fast updater may already have moved on, failed or cleared it; then it stays.
  if (child.pid) adoptPid(dataDir, claim, child.pid);

  return NextResponse.json({
    success: true,
    message: 'Update started. Rev4a restarts itself once the new version is installed.',
    log: 'update.log',
  });
}
