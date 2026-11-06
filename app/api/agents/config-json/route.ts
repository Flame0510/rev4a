/**
 * GET /api/agents/config-json?name=<container>
 *
 * Returns openclaw.json structure with secrets redacted on the server.
 * Used by the Agents page to inspect container config without SSH.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerExec } from '@/lib/docker-exec';
import { redactConfigSecrets } from '@/lib/redact-secret';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const name = request.nextUrl.searchParams.get('name');
    if (!name) {
      return NextResponse.json({ error: 'name query param is required' }, { status: 400 });
    }

    // Sanitize
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (safeName !== name) {
      return NextResponse.json({ error: 'Invalid container name' }, { status: 400 });
    }

    const raw = (await dockerExec(safeName, ['cat', '/root/.openclaw/openclaw.json'], {
      timeoutMs: 8000, maxBuffer: 512 * 1024,
    })).trim();

    if (!raw) {
      return NextResponse.json({ error: 'Config file not found or empty in container' }, { status: 404 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({
        error: 'Failed to parse config JSON',
      }, { status: 500 });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Config JSON must be an object' }, { status: 500 });
    }

    return NextResponse.json({ name: safeName, config: redactConfigSecrets(parsed) });
  } catch (e) {
    if (/cat:.*openclaw\.json.*No such file or directory/i.test((e as Error)?.message ?? '')) {
      return NextResponse.json({ error: 'Config file not found or empty in container' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Could not read the agent config' }, { status: 500 });
  }
}
