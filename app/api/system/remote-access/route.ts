import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { readAccessSettings, startupAccessSettings } from '@/lib/remote-access-server';
import { presetEdits, presetGuard, type AccessPreset } from '@/lib/remote-access';
import { saveEnvironment } from '@/lib/env-edit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied;
  try { return NextResponse.json({ settings: readAccessSettings(), startupSettings: startupAccessSettings() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Could not read access settings' }, { status: 500 }); }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied;
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  try {
    if (!['local', 'direct', 'domain'].includes(body?.preset) || typeof body?.location?.hostname !== 'string' || typeof body?.location?.protocol !== 'string') {
      return NextResponse.json({ error: 'Preset and browser location required' }, { status: 400 });
    }
    const preset = body.preset as AccessPreset;
    const guard = presetGuard(preset, body.location);
    if (!guard.allowed || (guard.needsConfirm && body.proxyConfirmed !== true)) return NextResponse.json({ error: guard.reason || 'Confirm that your HTTPS proxy is tested first' }, { status: 400 });
    const edits = presetEdits(preset, readAccessSettings());
    // Do not silently change a confirmation while another tab edits trusted proxies.
    if (!body.edits || Object.keys(body.edits).length !== Object.keys(edits).length || Object.entries(edits).some(([key, value]) => body.edits[key] !== value)) {
      return NextResponse.json({ error: 'Access settings changed. Review the preset again.' }, { status: 409 });
    }
    return saveEnvironment({ env: edits }, true);
  } catch { return NextResponse.json({ error: 'Could not apply access preset' }, { status: 500 }); }
}
