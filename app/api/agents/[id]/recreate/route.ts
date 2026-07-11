import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

const DEFAULT_NETWORK = 'openclaw-core_default';

/**
 * POST /api/agents/[id]/recreate
 * Stop → rm → run with same image, env, labels, and the persistent volume.
 * Workspace data, credentials, and state are preserved in the volume.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });

    // Inspect the existing container to capture its parameters
    let inspect: string;
    try {
      inspect = execSync(
        `docker inspect ${id}`,
        { timeout: 10000, encoding: 'utf-8' },
      ).trim();
    } catch {
      return NextResponse.json({ error: `Container '${id}' not found` }, { status: 404 });
    }

    const info = JSON.parse(inspect);
    const [container] = info;

    const image = container.Config?.Image || 'openclaw-agent-base:latest';
    const env: string[] = container.Config?.Env || [];

    // Filter and reformat env vars (skip system vars, keep AGENT_*, MODEL_*, OPENCLAW_*, TZ)
    const keepPrefixes = ['AGENT_', 'MODEL_', 'OPENCLAW_', 'TZ='];
    const envOpts = env
      .filter((e: string) => keepPrefixes.some((p) => e.startsWith(p)))
      .map((e: string) => `-e ${shellQuote(e)}`)
      .join(' ');

    // Extract labels (keep AGENT_ID, traefik.*, description, maintainer)
    const labels = container.Config?.Labels || {};
    const keepLabelKeys = ['AGENT_ID', 'traefik.', 'description', 'maintainer'];
    const labelOpts = Object.entries(labels)
      .filter(([k]) => keepLabelKeys.some((p) => k === p || k.startsWith(p)))
      .map(([k, v]) => `-l ${shellQuote(`${k}=${v}`)}`)
      .join(' ');

    // Determine network
    const networks = container.NetworkSettings?.Networks || {};
    const network = Object.keys(networks)[0] || DEFAULT_NETWORK;

    // Determine if there was a custom port mapping
    const portMappings = (container.HostConfig?.PortBindings || {}) as Record<string, { HostPort: string }[]>;
    const portOpts = Object.entries(portMappings)
      .map(([containerPort, bindings]) => {
        const hostPort = bindings[0]?.HostPort;
        if (!hostPort) return '';
        const proto = containerPort.includes('/udp') ? '/udp' : '';
        return `-p ${hostPort}:${containerPort.replace(/\/.*$/, '')}${proto}`;
      })
      .filter(Boolean)
      .join(' ');

    // Stop & remove the old container
    execSync(`docker rm -f ${id} 2>/dev/null; exit 0`, { timeout: 15000 });

    // Run the new container with the same image, env, labels, network, and volume
    const volumeName = `agent-${id}-data`;

    const cmd = [
      `docker run -d`,
      `--name "${id}"`,
      `--network "${network}"`,
      `--restart unless-stopped`,
      `--add-host host.docker.internal:host-gateway`,
      `-v ${volumeName}:/root`,
      labelOpts,
      envOpts,
      portOpts,
      `"${image}"`,
    ].filter(Boolean).join(' \\\n  ');

    execSync(cmd, { timeout: 60000, encoding: 'utf-8' });

    return NextResponse.json({ success: true, name: id, image, network });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
