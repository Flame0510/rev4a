import type { NextRequest } from 'next/server';
import { getDomainStatus } from '@/lib/domain-status';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { REV4A_DATA } from '@/lib/rev4a-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAuthJWT(request);
  if (denied) {
    denied.headers.set('Cache-Control', 'no-store');
    return denied;
  }
  return Response.json(await getDomainStatus(process.env, REV4A_DATA), { headers: { 'Cache-Control': 'no-store' } });
}
