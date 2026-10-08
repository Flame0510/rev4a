import { NextResponse } from 'next/server';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs';
import { join } from 'path';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { isInProgress, readUpdate, redact } from '@/lib/update-state';

const LOG_LINES = 20;
/** How far back the run's marker line is searched for; the last twenty lines after it are returned. */
const MARKER_BYTES = 256 * 1024;

/**
 * The version this server is running: server.js records it once at process start.
 * package.json on disk is not that — npm replaces it before the build and the restart.
 * The disk read is only the fallback for a server started without server.js (next dev).
 */
function runningVersion(): string | null {
  const recorded = process.env.REV4A_RUNNING_VERSION;
  if (recorded) return recorded;
  const candidates = [join(process.cwd(), 'package.json'), join(__dirname, '..', '..', '..', 'package.json')];
  for (const pkgPath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The last lines of `update.log` (npm and build output) written by this run, without
 * terminal control codes: only what follows the marker line the dashboard wrote for the
 * run that started at `startedAt`. None when there is no marker (an update started from a
 * shell writes to its terminal, not to the log), so an older run's output is never shown.
 */
function logTail(startedAt: number | null): string[] {
  if (startedAt === null) return [];
  let fd: number | null = null;
  try {
    fd = openSync(join(REV4A_DATA, 'data', 'update.log'), 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, MARKER_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf
      .toString('utf-8')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .split(/\r\n|\r|\n/);
    const marker = `] rev4a update ${startedAt}, started from the dashboard`;
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('[') && lines[i].trimEnd().endsWith(marker)) { at = i; break; }
    }
    if (at < 0) return [];
    return lines
      .slice(at + 1)
      .map((l) => redact(l.trimEnd()))
      .filter(Boolean)
      .slice(-LOG_LINES);
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * GET /api/update-status
 *
 * Cheap and local (one small file, no network): the UpdatingScreen of every tab polls it
 * to learn that Rev4a is updating, which phase it is in and whether it failed. `running`
 * is true only while an update is in progress; `phase` also reports a recent `done` or
 * `failed` so a tab can tell how the last update ended. `version` is the version this
 * server process runs (fixed when it started), not package.json on disk, which npm has
 * already replaced while the old server is still answering. The screen and the banner
 * reload only when it differs from the version the update started from.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const state = readUpdate(join(REV4A_DATA, 'data'));
  const running = isInProgress(state);
  return NextResponse.json(
    {
      running,
      phase: state?.phase ?? null,
      from: state?.from ?? null,
      to: state?.to ?? null,
      startedAt: state?.startedAt ?? null,
      updatedAt: state?.updatedAt ?? null,
      error: state?.phase === 'failed' && state.error ? redact(state.error) : null,
      version: runningVersion(),
      // The log is only the update's own output; skip reading it when nothing happened.
      logTail: state ? logTail(state.startedAt) : [],
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
