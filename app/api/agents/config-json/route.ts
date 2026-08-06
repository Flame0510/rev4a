/**
 * GET /api/agents/config-json?name=<container>
 *
 * Returns the full content of openclaw.json from a container.
 * Used by the Agents page to inspect container config without SSH.
 */
import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';

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

    const raw = execSync(
      `docker exec ${safeName} cat /root/.openclaw/openclaw.json 2>/dev/null || true`,
      { timeout: 8000, encoding: 'utf-8', maxBuffer: 512 * 1024 },
    ).trim();

    if (!raw) {
      return NextResponse.json({ error: 'Config file not found or empty in container' }, { status: 404 });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({
        error: 'Failed to parse config JSON',
        content: raw.slice(0, 500),
      }, { status: 500 });
    }

    // Sanitize: mask tokens in the response
    const sanitized = JSON.parse(JSON.stringify(parsed));
    if (sanitized.gateway?.auth?.token) {
      sanitized.gateway.auth.token = '***';
    }

    return NextResponse.json({ name: safeName, config: sanitized });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
