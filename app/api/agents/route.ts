import { NextResponse, type NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { detectPublicHost } from '@/lib/docker-utils';
import { AGENTS_TOKEN_FILE } from '@/lib/rev4a-paths';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerAvailable, dockerFetch } from '@/lib/docker-socket';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  // If Docker is not available (e.g. testing environment), return empty list
  if (!dockerAvailable()) {
    return NextResponse.json([]);
  }

  try {
    // List all containers (including stopped) with AGENT_ID label via Docker API
    const containers: any[] = await dockerFetch(
      'GET',
      '/containers/json?all=true&filters={"label":["AGENT_ID"]}',
    );

    // Current image ID — used to detect outdated containers
    let currentImageId = '';
    try {
      const imageInspect = await dockerFetch('GET', '/images/openclaw-agent-base:latest/json');
      currentImageId = imageInspect.Id || '';
    } catch {
      // Image doesn't exist yet — all containers are fine
    }

    const agents = await Promise.all(
      containers.map(async (c: any) => {
        const agentId = c.Labels?.AGENT_ID || 'unknown';
        let ip: string | null = null;
        let created: string | null = null;
        let env: string[] = [];
        let authToken: string | null = null;
        let traefikUrl: string | null = null;
        let portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> | null = null;

        try {
          const inspect: any = await dockerFetch(
            'GET',
            `/containers/${c.Id}/json`,
          );
          const networks: Record<string, any> =
            inspect.NetworkSettings?.Networks || {};
          ip =
            Object.values(networks).find(
              (n: any) => n.IPAddress,
            )?.IPAddress || null;
          created = inspect.Created || null;
          env = (inspect.Config?.Env || []).filter((e: string) =>
            e.startsWith('AGENT_') || e.startsWith('MODEL_')
          );

          // Ports from inspect (HostConfig) — works even when container is stopped
          portBindings = inspect.HostConfig?.PortBindings || null;

          // Read auth token — always prefer the shared agents-token.json (user-managed)
          const cName = (c.Names?.[0] || '').replace(/^\//, '');
          try {
            const tokenRaw = fs.readFileSync(
              AGENTS_TOKEN_FILE,
              'utf-8'
            );
            const tokenData = JSON.parse(tokenRaw);
            if (tokenData.token) {
              authToken = tokenData.token;
            }
          } catch {
            // agents-token.json unavailable
          }

          // Fallback only if shared token is missing: try the container's own gateway token
          if (!authToken) {
            try {
              const { execSync } = require('child_process');
              let token = execSync(
                `docker exec ${cName} sh -c 'grep ^OPENCLAW_GATEWAY_TOKEN= /root/….env 2>/dev/null | cut -d= -f2- | tr -d "\"\""' 2>/dev/null || echo ''`,
                { timeout: 5000, encoding: 'utf-8' }
              ).toString().trim();
              if (token && token !== 'undefined') authToken = token;
            } catch {
              // token unavailable for this container
            }
          }

          // Build the agent URL from the host's public IP + mapped port.
          // Every agent has -p <port>:3000, so we look for the public port
          // that maps to the internal port 3000.
          // Use portBindings from inspect (works stopped) with fallback to c.Ports (running only).
          const port3000Binding = portBindings?.['3000/tcp'];
          const publicPort = port3000Binding?.[0]?.HostPort
            || (c.Ports || []).find((p: any) => p.PublicPort && p.PrivatePort === 3000)?.PublicPort
            || null;
          if (publicPort) {
            const host = detectPublicHost();
            let baseUrl = `http://${host}:${publicPort}`;
            if (authToken) {
              baseUrl += `#token=${encodeURIComponent(authToken)}`;
            }
            traefikUrl = baseUrl;
          }
        } catch {
          // inspect non-critical, continue with partial data
        }

        // Determine template from AGENT_TEMPLATE env var.
        // Falls back to 'custom' if not set (agent created before this feature).
        const image: string = c.Image || '';
        let template: string | null = null;
        if (image.startsWith('openclaw-agent-base')) {
          const templateLine = env.find((e: string) => e.startsWith('AGENT_TEMPLATE='));
          template = templateLine ? templateLine.split('=').slice(1).join('=') : 'custom';
        }

        // Build ports string from portBindings (works stopped) with fallback to c.Ports (running only)
        let ports = '';
        if (portBindings && Object.keys(portBindings).length > 0) {
          ports = Object.entries(portBindings)
            .flatMap(([containerPort, hostPorts]) =>
              (hostPorts as any[]).map((h: any) => `${h.HostPort}:${containerPort.replace('/tcp', '')}${containerPort.includes('/udp') ? '/udp' : ''}`)
            )
            .join(', ');
        } else {
          ports = (c.Ports || [])
            .filter((p: any) => p.PublicPort)
            .map(
              (p: any) =>
                `${p.PublicPort}:${p.PrivatePort}${p.Type === 'udp' ? '/udp' : ''}`,
            )
            .join(', ');
        }

        return {
          id: (c.Id || '').slice(0, 12),
          agentId,
          name: (c.Names?.[0] || '').replace(/^\//, ''),
          displayName: (env.find((e: string) => e.startsWith('AGENT_NAME=')) || '').split('=').slice(1).join('=') || (c.Names?.[0] || '').replace(/^\//, ''),
          image,
          imageTag: image.includes(':') ? image.split(':')[1] || 'latest' : (image.includes('@') ? 'digest' : 'latest'),
          template,
          status: c.Status || 'unknown',
          state: c.State || 'unknown',
          ports,
          ip,
          created,
          env,
          traefikUrl,
          authToken,
          // Flag as outdated when the container's image differs from the current base image.
          // We compare raw ImageID digests — no fragile name-based filtering.
          imageOutdated: currentImageId ? c.ImageID !== currentImageId : false,
        };
      }),
    );

    // Deduplicate by agentId > use the running one when multiple
    const seen = new Map<string, typeof agents[0]>();
    for (const agent of agents) {
      const existing = seen.get(agent.agentId);
      if (!existing || (agent.state === 'running' && existing.state !== 'running')) {
        seen.set(agent.agentId, agent);
      }
    }

    return NextResponse.json(Array.from(seen.values()));
  } catch (e: unknown) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
