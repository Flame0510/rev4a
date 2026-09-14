import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { patchRev4aProvider } from '@/app/api/gateway/sync';
import { getMountFlags, applyRuntimeConfig } from '@/lib/agent-setup';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { waitForGatewayReady } from '@/lib/agent-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 180; // docker run (60s) + startup wait (60s) + config patch (60s)

const BACKUP_VOLUME = 'rev4a-backups';

/** Timestamp YYYY-MM-DD_HHmmssSSS (ms precision avoids same-second collisions). */
function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ms}`;
}


/**
 * POST /api/agents/[id]/recreate
 * Stop -> backup -> rm -> run with same params + shared volumes.
 * Workspace data and state are preserved in the persistent volume.
 * Shared volumes (skills, repos) are always mounted.
 * After the container is up, guarantee extraDirs + provider config.
 */
export async function POST(request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent name required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    // Resolve the actual container name via AGENT_ID label
    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    // Inspect the existing container to capture its parameters
    let inspect: string;
    try {
      inspect = execSync(
        `docker inspect ${containerName}`,
        { timeout: 10000, encoding: 'utf-8' },
      ).trim();
    } catch {
      return NextResponse.json({ error: `Container '${containerName}' not found` }, { status: 404 });
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

    // Determine network (must exist on the container)
    const networks = container.NetworkSettings?.Networks || {};
    const network = Object.keys(networks)[0];
    if (!network) {
      return NextResponse.json({ error: 'Cannot determine network — container may have no networks attached' }, { status: 500 });
    }

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

    const volumeName = `agent-${id}-data`;

    // Auto-backup the volume BEFORE destroying the container
    const backupFile = `agent-${id}-prerecreate-${ts()}.tar.gz`;
    try {
      execSync(
        `docker run --rm ` +
        `-v ${volumeName}:/source:ro ` +
        `-v ${BACKUP_VOLUME}:/backup ` +
        `alpine sh -c 'tar czf /backup/${backupFile} --exclude=.npm/_cacache -C /source . && chmod 644 /backup/${backupFile}'`,
        { timeout: 60000, stdio: 'pipe' },
      );
    } catch (backupErr) {
      return NextResponse.json(
        { error: `Pre-recreate backup failed, aborting: ${(backupErr as Error).message}` },
        { status: 500 },
      );
    }

    // Stop & remove the old container. If removal fails (Docker daemon
    // overloaded, container stuck in "removal in progress"), abort — we
    // can't run a new container with a conflicting name.
    try {
      execSync(`docker rm -f ${containerName}`, { timeout: 15000 });
    } catch (rmErr) {
      return NextResponse.json(
        { error: `Failed to remove old container '${containerName}': ${(rmErr as Error).message}. The original container may still be running.` },
        { status: 500 },
      );
    }

    // Run the new container with all mounts (persistent volume + shared skills + shared repos + rev4a rules)
    const cmd = [
      `docker run -d`,
      `--name "${id}"`,
      `--network "${network}"`,
      `--restart unless-stopped`,
      `--add-host host.docker.internal:host-gateway`,
      `-v ${volumeName}:/root`,
      ...getMountFlags(),
      labelOpts,
      envOpts,
      portOpts,
      `"${image}"`,
    ].filter(Boolean).join(' \\\n  ');

    execSync(cmd, { timeout: 60000, encoding: 'utf-8' });

    // Wait for the new container to finish starting — /startupz, not /health
    const ready = await waitForGatewayReady(id);
    if (!ready) {
      return NextResponse.json(
        { success: false, error: 'Container started but its gateway did not finish starting within 60s.' },
        { status: 500 },
      );
    }

    // Guarantee Rev4a runtime config (hooks, shared-skills, provider).
    // Uses config patch (deep-merge) — idempotent, preserves user customizations.
    try {
      applyRuntimeConfig(id);

      // Also guarantee models.providers.rev4a (host-dependent, not in base image)
      patchRev4aProvider(id);
    } catch (e) {
      // best-effort on recreate, but a skipped patch must show up in the log
      console.error('[agent:recreate] runtime config patch failed:', (e as Error).message);
    }

    return NextResponse.json({ success: true, name: id, image, network, backup: backupFile });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
