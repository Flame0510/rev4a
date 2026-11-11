import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { dockerAvailable, dockerFetch } from '@/lib/docker-socket';
import { containerOpenClawVersion, imageOpenClawVersion, listLocalAgentImages, newestLocalSupportedVersion, type LocalAgentImage } from '@/lib/agent-images';
import { LOCAL_IMAGE_REPOSITORY, compareVersions, newBuildAvailableFor } from '@/lib/agent-versions';

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

    // Local agent images: each container's OpenClaw version, and the newest supported
    // version downloaded, which decides `updateAvailable`.
    let images: LocalAgentImage[] = [];
    try {
      images = await listLocalAgentImages();
    } catch {
      // No image list: versions come from inside running containers only.
    }
    const newestLocal = newestLocalSupportedVersion(images);

    const agents = await Promise.all(
      containers.map(async (c: any) => {
        const agentId = c.Labels?.AGENT_ID || 'unknown';
        let ip: string | null = null;
        let created: string | null = null;
        let env: string[] = [];
        let controlPort: string | null = null;
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

          // The host port mapped to the agent's Control UI (container port 3000).
          // No link and no token are returned: the Open buttons go through
          // /api/agents/[id]/open-control-ui, which builds the link server-side.
          // Read from portBindings (works on a stopped container) with a fallback
          // to c.Ports, which is only populated while running.
          const port3000Binding = portBindings?.['3000/tcp'];
          controlPort = port3000Binding?.[0]?.HostPort
            || (c.Ports || []).find((p: any) => p.PublicPort && p.PrivatePort === 3000)?.PublicPort?.toString()
            || null;
        } catch {
          // inspect non-critical, continue with partial data
        }

        // Determine template from AGENT_TEMPLATE env var.
        // Falls back to 'custom' if not set (agent created before this feature).
        const image: string = c.Image || '';
        let template: string | null = null;
        // Every container here carries AGENT_ID, so its version is looked up even when
        // its image is not tagged `openclaw-agent-base` (an image left untagged, or
        // pinned by id). The image name alone would miss those.
        const openclawVersion = await containerOpenClawVersion(
          { id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), imageId: c.ImageID || '', running: c.State === 'running' },
          images,
        );
        // Recreate acts only on image metadata, so an exec-only version cannot
        // promise a different build. Inspect by id also covers unlisted images.
        const imageVersion = await imageOpenClawVersion(c.ImageID || '', images);
        const isAgentBase = image.startsWith(LOCAL_IMAGE_REPOSITORY)
          || images.some((img) => img.id === c.ImageID)
          || openclawVersion !== null;
        if (isAgentBase) {
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
          controlPort,
          openclawVersion,
          // A newer supported OpenClaw version is downloaded. Recreate keeps the agent's
          // version; moving to the newer one is a separate, backed-up update.
          updateAvailable: !!(openclawVersion && newestLocal && compareVersions(newestLocal, openclawVersion) > 0),
          // The build this release pins for the agent's version is downloaded and the
          // container runs another image: a recreate moves it to the pinned build.
          newBuildAvailable: !!(imageVersion && c.ImageID && newBuildAvailableFor(imageVersion, images, c.ImageID)),
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
