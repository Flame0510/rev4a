import type { NextRequest } from 'next/server';
import { readDomainCredential } from '@/lib/caddy';
import { domainConfig } from '@/lib/domain';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { REV4A_DATA } from '@/lib/rev4a-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAuthJWT(request);
  if (denied) {
    for (const [name, value] of Object.entries(headers)) denied.headers.set(name, value);
    return denied;
  }
  try {
    if (domainConfig(process.env)) {
      const credential = await readDomainCredential(REV4A_DATA);
      if (credential) return Response.json(credential, { headers });
    }
  } catch { /* Invalid server configuration must not disclose credential data. */ }
  return Response.json({ error: 'Dev-port credential unavailable.' }, { status: 404, headers });
}
