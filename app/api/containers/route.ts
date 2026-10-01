import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerAvailable, dockerFetch } from '@/lib/docker-socket';
import { primaryName } from '@/lib/docker-stats';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  if (!dockerAvailable()) {
    return NextResponse.json([]);
  }

  try {
    const containers: any[] = await dockerFetch('GET', '/containers/json?all=true');

    const enriched = await Promise.all(containers.map(async (c: any) => {
      try {
        const inspect: any = await dockerFetch('GET', `/containers/${c.Id}/json`);
        const networks: Record<string, any> = inspect.NetworkSettings?.Networks || {};
        const ip = Object.values(networks)[0]?.IPAddress || null;
        return {
          id: c.Id?.slice(0, 12),
          // The daemon's rule (the name with one leading slash), so the usage row and the
          // /system?agent= link key on the same name the metrics store uses.
          name: primaryName(c?.Names),
          image: c.Image,
          status: c.Status,
          state: c.State,
          ports: c.Ports?.map((p: any) => `${p.PublicPort || '?'}:${p.PrivatePort || '?'}`).join(', ') || '',
          ip,
          agentId: c.Labels?.AGENT_ID || null,
          displayName: (inspect.Config?.Env || []).find((e: string) => e.startsWith('AGENT_NAME='))?.split('=').slice(1).join('=') || null,
          created: c.Labels?.created || null,
        };
      } catch {
        // Identity comes from the list: a failed inspect must neither drop the container nor
        // give it a name the metrics store does not key on. Only the inspect-only fields are lost.
        return {
          id: c.Id?.slice(0, 12),
          name: primaryName(c?.Names),
          image: c.Image,
          status: c.Status,
          state: c.State,
          ports: c.Ports?.map((p: any) => `${p.PublicPort || '?'}:${p.PrivatePort || '?'}`).join(', ') || '',
          ip: null,
          agentId: c.Labels?.AGENT_ID || null,
          displayName: null,
          created: c.Labels?.created || null,
        };
      }
    }));

    return NextResponse.json(enriched);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
