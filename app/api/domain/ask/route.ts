import { readFile } from 'node:fs/promises';
import { checkAgentRoute } from '@/lib/caddy';
import { domainAsk } from '@/lib/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return new Response(null, { status: await domainAsk(request, process.env, readFile, checkAgentRoute) });
}
