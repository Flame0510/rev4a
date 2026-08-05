import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentedContainer, isValidAgentId } from '@/lib/container';
import { buildRev4aProviderConfig } from '@/app/api/gateway/sync';
import { getMountFlags, applyRuntimeConfig } from '@/lib/agent-setup';
import { DB_FILE } from '@/lib/rev4a-paths';

const BACKUP_VOLUME = 'rev4a-backups';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    if (!id || id.length < 1) {
      return NextResponse.json(
        { success: false, error: 'Container name or ID is required' },
        { status: 400 },
      );
    }
    if (!isValidAgentId(id)) {
      return NextResponse.json({ success: false, error: 'Invalid agent id' }, { status: 400 });
    }

    // Only allow deletion of containers that have a matching AGENT_ID label
    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    execSync(`docker rm -f "${containerName}"`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Destructive delete: also remove the persistent volume and all backups.
    // The container is already gone, so the volume is no longer in use.
    // Best-effort — a missing volume or absent backups must not fail the delete.
    try {
      execSync(`docker volume rm agent-${id}-data`, { timeout: 15000, stdio: 'pipe' });
    } catch {
      // volume may not exist (legacy agent) or already removed — ignore
    }
    try {
      execSync(
        `docker run --rm -v ${BACKUP_VOLUME}:/backup alpine sh -c 'rm -f /backup/agent-${id}-*.tar.gz'`,
        { timeout: 20000, stdio: 'pipe' },
      );
    } catch {
      // no backups or backup volume missing — ignore
    }

    // Log event to events.db if it exists
    try {
      const Database = require('better-sqlite3');
      const dbPath = DB_FILE;
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.prepare(
          `INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)`,
        ).run(Date.now(), `system:agents`, 'agent_deleted', JSON.stringify({
          name: id,
          containerName,
        }));
        db.close();
      }
    } catch {
      // DB logging is optional, ignore failures
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const err = e as Error;
    return NextResponse.json(
      { success: false, error: err.message || 'Unknown error' },
      { status: 500 },
    );
  }
}

function waitForContainerReady(name: string, timeoutMs = 60000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(
        `docker exec ${name} sh -c 'curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1 || wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1'`,
        { timeout: 5000 },
      );
      return true;
    } catch { /* not ready */ }
    execSync('sleep 2', { timeout: 3000 });
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * PATCH /api/agents/[id]
 *
 * Update agent settings (display name, ports — future).
 * Recreates the container with updated env vars while preserving the
 * persistent volume, workspace, sessions, and all data.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Agent ID required' }, { status: 400 });
    if (!isValidAgentId(id)) return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 });

    let body: { displayName?: string; portRange?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { displayName, portRange } = body;
    if (!displayName && !portRange) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    if (displayName !== undefined && (!displayName || displayName.trim().length < 1)) {
      return NextResponse.json({ error: 'Display name must not be empty' }, { status: 400 });
    }

    // Resolve the container
    const containerName = resolveAgentedContainer(id);
    if (!containerName) {
      return NextResponse.json({ error: `No container found with AGENT_ID '${id}'` }, { status: 404 });
    }

    // Inspect existing container
    let inspect: string;
    try {
      inspect = execSync(`docker inspect ${containerName}`, { timeout: 10000, encoding: 'utf-8' }).trim();
    } catch {
      return NextResponse.json({ error: `Container '${containerName}' not found` }, { status: 404 });
    }

    const info = JSON.parse(inspect);
    const [container] = info;
    const image = container.Config?.Image || 'openclaw-agent-base:latest';
    const currentEnv: string[] = container.Config?.Env || [];

    // Update AGENT_NAME in env vars
    let env = [...currentEnv];
    if (displayName) {
      const idx = env.findIndex((e: string) => e.startsWith('AGENT_NAME='));
      const newEntry = `AGENT_NAME=${displayName.trim()}`;
      if (idx >= 0) {
        env[idx] = newEntry;
      } else {
        env.push(newEntry);
      }
    }

    // Keep only relevant env vars
    const keepPrefixes = ['AGENT_', 'MODEL_', 'OPENCLAW_', 'TZ='];
    const envOpts = env
      .filter((e: string) => keepPrefixes.some((p) => e.startsWith(p)))
      .map((e: string) => `-e ${shellQuote(e)}`)
      .join(' ');

    // Labels
    const labels = container.Config?.Labels || {};
    const keepLabelKeys = ['AGENT_ID', 'traefik.', 'description', 'maintainer'];
    const labelOpts = Object.entries(labels)
      .filter(([k]) => keepLabelKeys.some((p) => k === p || k.startsWith(p)))
      .map(([k, v]) => `-l ${shellQuote(`${k}=${v}`)}`)
      .join(' ');

    // Network
    const networks = container.NetworkSettings?.Networks || {};
    const network = Object.keys(networks)[0];
    if (!network) {
      return NextResponse.json({ error: 'Cannot determine network' }, { status: 500 });
    }

    // Port mappings
    const portBindings = (container.HostConfig?.PortBindings || {}) as Record<string, { HostPort: string }[]>;
    let portOpts = Object.entries(portBindings)
      .map(([containerPort, bindings]) => {
        const hostPort = bindings[0]?.HostPort;
        if (!hostPort) return '';
        const proto = containerPort.includes('/udp') ? '/udp' : '';
        return `-p ${hostPort}:${containerPort.replace(/\/.*$/, '')}${proto}`;
      })
      .filter(Boolean)
      .join(' ');

    // If portRange is provided, replace the port mapping
    if (portRange) {
      const parts = portRange.trim().split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : start;
      if (isNaN(start) || isNaN(end) || start < 1 || end > 65535 || end < start) {
        return NextResponse.json({ error: 'Invalid port range' }, { status: 400 });
      }
      if (end === start) {
        portOpts = `-p ${start}:3000`;
      } else {
        portOpts = `-p ${start}-${end}:3000-${3000 + (end - start)}`;
      }
    }

    const volumeName = `agent-${id}-data`;

    // Stop & remove old container (keep volume)
    try {
      execSync(`docker rm -f ${containerName}`, { timeout: 15000 });
    } catch (rmErr) {
      return NextResponse.json(
        { error: `Failed to remove old container: ${(rmErr as Error).message}` },
        { status: 500 },
      );
    }

    // Run new container with same volume
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

    // Wait for healthy
    const ready = waitForContainerReady(id);
    if (!ready) {
      return NextResponse.json(
        { error: 'Container started but gateway did not become healthy within 60s.' },
        { status: 500 },
      );
    }

    // Apply runtime config
    try {
      applyRuntimeConfig(id);
      const providerConfig = buildRev4aProviderConfig();
      const providerJson = JSON.stringify({ models: { providers: { rev4a: providerConfig } } });
      execSync(
        `docker exec -i ${id} sh -c 'openclaw config patch --stdin'`,
        { timeout: 15000, stdio: 'pipe', input: providerJson },
      );
      try { execSync(`docker exec ${id} openclaw gateway restart`, { timeout: 15000 }); } catch { /* non-fatal */ }
    } catch { /* non-fatal */ }

    return NextResponse.json({
      success: true,
      displayName: displayName?.trim() || null,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}


