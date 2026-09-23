/**
 * GET /api/models/details?id=<model id>
 *
 * Everything the details modal shows for one model: the curated catalogue entry, the
 * price (and where it is from) and the generated specs, description and benchmarks
 * (`model-details.json`). Fetched when the modal opens rather than inlined in
 * `/api/models`, which pages poll: descriptions are long and only one model is looked at
 * at a time.
 *
 * Absent fields are simply absent — the modal hides those blocks instead of printing
 * "n/a" — and a model the catalogue does not carry is a plain 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getModelDetails } from '@/lib/model-details';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 });

  const details = getModelDetails(id);
  if (!details) return NextResponse.json({ error: `No model '${id}' in the catalogue` }, { status: 404 });

  return NextResponse.json(details, { headers: { 'Cache-Control': 'no-store' } });
}
