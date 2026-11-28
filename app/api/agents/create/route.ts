import { NextResponse, type NextRequest } from 'next/server';
import { execSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { patchRev4aProvider } from '../../gateway/sync';
import { readProviderKeys } from '../../gateway/provider/keys';
import { resolveCreateModel } from '@/lib/agent-model-setup';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { extractProviderAndModel } from '@/app/api/provider/upstream';
import { DB_FILE, AGENTS_TOKEN_FILE, PROVIDER_KEYS_FILE, templatesDir } from '@/lib/rev4a-paths';
import { getMountFlags, applyRuntimeConfig, withControlUiPolicy } from '@/lib/agent-setup';
import { listLocalAgentImages, runDocker, newestLocalSupportedVersion } from '@/lib/agent-images';
import { localImageRef } from '@/lib/agent-versions';
import { isModelOffered } from '@/lib/model-catalogue';
import { findAvailablePortBlock, portMappingArgs, validatePortInput, DEFAULT_BLOCK_SIZE } from '@/lib/agent-ports';
import { agentPortsHostIp, getUsedHostPorts } from '@/lib/agent-ports-server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { configErrorSummary, redactSecret, redactedMessage } from '@/lib/redact-secret';
import { acquireTokenLock } from '@/lib/agent-token-lock';
import { buildCreateRunArgs } from '@/lib/agent-create-args';
import { parseLimitMb, mbToBytes } from '@/lib/agent-memory-limit';
import { agentVolumeName, isEmulated, readyTimeoutMs } from '@/lib/agent-volumes';
import { volumeExists, removeVolume, invalidateVolumesCache } from '@/lib/agent-volumes-server';
import { dockerGet } from '@/lib/agent-volumes-server';
import { acquireAgentResourcePreflight, AgentResourceRefusedError } from '@/lib/agent-resource-preflight';



// Port block discovery and validation are shared with the edit (rename/ports) flow, so
// both offer the same ranges and the same error messages (lib/agent-ports.ts).

export const dynamic = 'force-dynamic';
export const maxDuration = 480; // docker run (60s) + startup wait (120s, 300s under emulation) + seeding (60s)

const TEMPLATES_DIR = templatesDir(process.cwd());
const AGENTS_TOKEN_PATH = AGENTS_TOKEN_FILE;
const DEFAULT_NETWORK = 'rev4a-network';

/**
 * Used when the request names no model. The full id: the agent cards compare the
 * primary against catalogue ids, and the two-segment alias matches none of them.
 */
const DEFAULT_MODEL = 'rev4a/deepseek/deepseek-flash';

function isDockerCompatibleName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function generateContainerName(): string {
  const hex = crypto.randomBytes(4).toString('hex');
  return `agent_${hex}`;
}

interface CreateBody {
  name: string;
  template: string;
  portRange?: string;
  model?: unknown;
  noModel?: unknown;
  fallbacks?: string[];
  /** Optional memory limit in MB (256 to 1048576); absent, null or 0 means no limit. */
  memoryLimitMb?: number | string | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readAgentsToken(): string {
  try {
    const tokenRaw = fs.readFileSync(AGENTS_TOKEN_PATH, 'utf-8');
    const tokenData = JSON.parse(tokenRaw);
    return typeof tokenData.token === 'string' ? tokenData.token.trim() : '';
  } catch {
    return '';
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  // Read once so the outer catch can redact it from any error text.
  const createToken = readAgentsToken();
  // Held from reading the token to the end of `docker run`, so a token save cannot miss the new
  // container (lib/agent-token-lock.ts). Released on every exit.
  let releaseTokenLock: () => void = () => {};
  let releaseResources: () => void = () => {};
  // The token read under the lock (can differ from createToken if it was saved meanwhile).
  let laterToken = '';
  // Set once `docker run` is attempted. From then on any failure removes the container and, when this
  // request created it, the agent's data volume.
  let rollbackTarget: { container: string; volume: string; volumeExisted: boolean } | null = null;
  let finished = false;
  try {
    let body: CreateBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const { name: displayName, template, portRange: portInput, fallbacks } = body;

    // Validate display name
    if (!displayName || displayName.trim().length < 1) {
      return NextResponse.json(
        { success: false, error: 'Agent name is required' },
        { status: 400 },
      );
    }

    // Optional memory limit: validated before anything is created. The flags below are
    // built from the validated integer only, never from the request text.
    let memoryLimitMb: number | null;
    try {
      memoryLimitMb = parseLimitMb(body.memoryLimitMb);
    } catch (e) {
      return NextResponse.json({ success: false, error: (e as Error).message }, { status: 400 });
    }

    // Generate a unique container name (stable, never changes)
    const containerName = generateContainerName();

    // Validate template — must be a valid identifier (no path traversal).
    if (!isDockerCompatibleName(template)) {
      return NextResponse.json(
        { success: false, error: 'Invalid template name' },
        { status: 400 },
      );
    }

    // Validate template directory exists
    const templateDir = path.join(TEMPLATES_DIR, template);
    if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
      return NextResponse.json(
        {
          success: false,
          error: `Template '${template}' not found. Available: ${getAvailableTemplates().join(', ')}`,
        },
        { status: 400 },
      );
    }

    const modelSetup = resolveCreateModel(body, isValidModel, DEFAULT_MODEL);
    if (modelSetup.kind === 'error') {
      return NextResponse.json(
        { success: false, error: modelSetup.error },
        { status: modelSetup.status },
      );
    }
    const noModel = modelSetup.kind === 'none';
    if (noModel && 'fallbacks' in body) {
      return NextResponse.json(
        { success: false, error: 'Do not send fallbacks with noModel' },
        { status: 400 },
      );
    }

    // Check if name is already in use by a container, running or not: a stopped agent
    // keeps its name and its port block, so both would clash on start.
    const existing = execSync(
      `docker ps -a --filter "label=AGENT_ID=${containerName}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Agent '${displayName}' already exists (container: ${existing})` },
        { status: 409 },
      );
    }

    // Resolve port range. One lookup, shared by both paths below.
    const usedPorts = await getUsedHostPorts();
    let isBlock = false;
    let portStart: number = 0;
    let portEnd: number = 0;

    if (portInput) {
      const v = validatePortInput(portInput, usedPorts);
      if (!v.valid) {
        return NextResponse.json(
          { success: false, error: v.error },
          { status: 400 },
        );
      }
      isBlock = v.isBlock;
      portStart = v.start;
      portEnd = v.end;
    } else {
      portStart = findAvailablePortBlock(usedPorts);
      portEnd = portStart + DEFAULT_BLOCK_SIZE - 1;
      isBlock = true;
    }

    // Ensure shared volumes exist (created by rev4a serve preflight, defensive guard here)
    const mountFlags = getMountFlags();

    // Build docker run command
    // The newest supported OpenClaw version downloaded here (lib/agent-images.ts).
    let newestLocal: string | null = null;
    try {
      newestLocal = newestLocalSupportedVersion(await listLocalAgentImages());
    } catch {
      // Docker listed nothing usable: handled below as no image.
    }
    if (!newestLocal) {
      return NextResponse.json(
        { success: false, error: 'No supported agent image is downloaded. Download it from the Agents page first.' },
        { status: 409 },
      );
    }
    const image = localImageRef(newestLocal);
    releaseResources = await acquireAgentResourcePreflight({
      version: newestLocal, operation: 'create', targetAgentId: containerName, limitMb: memoryLimitMb,
    });
    const network = getNetwork();

    // Read agents token for new containers
    releaseTokenLock = await acquireTokenLock();
    const agentsToken = readAgentsToken();
    laterToken = agentsToken;
    if (!agentsToken) {
      return NextResponse.json(
        { success: false, error: 'Agents gateway token is missing. Set it from /agents before creating agents.' },
        { status: 400 },
      );
    }

    // `rev4a serve` creates this network at start-up, but skips it when Docker was
    // not ready yet; without it `docker run --network` fails. Idempotent.
    ensureNetworkExists(network);

    // Every agent gets a host port range for direct access. The Control UI link
    // is built per click by /api/agents/[id]/open-control-ui, from the host the
    // dashboard is reached on.
    //
    // There used to be an AGENT_HOSTNAME env var here, holding `<detected-ip>:<port>`.
    // Nothing ever read it: verified across this repo and across the whole
    // filesystem of a running agent container, binaries included, with a control
    // search proving the method finds AGENT_ID and OPENCLAW_GATEWAY_TOKEN in the
    // same sweep. Worse, a container's env is immutable and recreate copies every
    // AGENT_* var forward, so a wrong address was frozen in and propagated for the
    // life of the agent, with no code path anywhere that could refresh it.
    const labels: string[] = [`AGENT_ID=${containerName}`];
    const envVars: string[] = [
      `AGENT_ID=${containerName}`,
      `AGENT_NAME=${displayName.trim()}`,
      `AGENT_TEMPLATE=${template}`,
      `TZ=Europe/Rome`,
    ];


    // Template files that will be copied into the container workspace.
    // Files that don't exist in the template dir are silently skipped —
    // this is intentional (e.g. BOOTSTRAP.md only exists in custom/).
    const templateFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];

    // --init: Docker's tini runs as PID 1 and collects orphaned processes. Without it
    // openclaw-gateway is PID 1 and never does, so every process a tool leaves behind
    // (Chrome, builds, scripts) stays a zombie and counts against the container's pids
    // limit until the container can no longer start anything. Same flag in
    // lib/agent-recreate.ts.
    // The gateway token reaches docker through its environment (runDocker adds `-e KEY`):
    // it never appears in argv, in a shell string or in an error message.
    const runArgs = buildCreateRunArgs({
      containerName,
      network,
      mountFlags,
      memoryBytes: memoryLimitMb === null ? null : mbToBytes(memoryLimitMb),
      labels,
      envVars,
      portArgs: portMappingArgs(portStart, portEnd, agentPortsHostIp()),
      image,
    });
    const volumeName = agentVolumeName(containerName);
    rollbackTarget = { container: containerName, volume: volumeName, volumeExisted: volumeExists(volumeName) };
    let runOutput = '';
    await runDocker(runArgs, {
      env: { OPENCLAW_GATEWAY_TOKEN: agentsToken },
      timeoutMs: 60000,
      // onLine mixes stdout and stderr: keep only what looks like the container id `docker run -d` prints,
      // so a warning printed after it cannot take its place.
      onLine: (line) => { const t = line.trim(); if (/^[0-9a-f]{64}$/.test(t)) runOutput = t; },
    });
    const containerId = runOutput;
    releaseTokenLock();

    // Log event to events.db if it exists
    try {
      const Database = require('better-sqlite3');
      const dbPath = DB_FILE;
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.prepare(
          `INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)`,
        ).run(Date.now(), `system:agents`, 'agent_created', JSON.stringify({
          name: displayName,
          template,
          port: portStart,
          portEnd,
          isBlock,
          model: modelSetup.kind === 'model' ? modelSetup.model : null,
          ...(noModel ? { noModel: true } : {}),
          fallbacks,
          containerId,
          containerName,
        }));
        db.close();
      }
    } catch {
      // DB logging is optional, ignore failures
    }

    // Wait for startup to complete (/startupz, up to 120s). Not /health, which
    // answers as soon as the HTTP server listens. If it does not come up, remove
    // the container: a zombie agent with no config is worse than an explicit failure.
    // Under emulation (image and Docker host architectures differ) a first boot takes several times
    // longer, so the window is 300 s instead of 120 s.
    const { imageArch, hostArch } = await readArchitectures(image);
    const emulated = isEmulated(imageArch, hostArch);
    const readyMs = readyTimeoutMs(imageArch, hostArch);
    if (emulated) {
      console.log(`[agent:create] ${containerName}: image is ${imageArch}, Docker host is ${hostArch} (emulated); waiting up to ${readyMs / 1000}s for the gateway`);
    }
    const ready = await waitForGatewayReady(containerName, readyMs);
    if (!ready) {
      const removed = rollbackCreate(rollbackTarget);
      rollbackTarget = null;
      return NextResponse.json(
        {
          success: false,
          error: `Container started but its gateway did not finish starting within ${readyMs / 1000}s${emulated ? ' (the image runs under emulation on this host, so it is slower)' : ''}. ${removed} Try again.`,
        },
        { status: 500 },
      );
    }

    // ── Container is up, now seed the workspace and config ──
    try {
      // Create workspace dir
      execSync(
        `docker exec ${containerName} mkdir -p /root/.openclaw/workspace`,
        { timeout: 10000, stdio: 'pipe' },
      );

      // Copy template files into the container workspace.
      // Skip files that already exist (user may have edited them on a prior
      // deployment — the volume persists across recreates).
      for (const tf of templateFiles) {
        const src = path.join(templateDir, tf);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
        // Check if the file already exists in the container workspace
        try {
          execSync(
            `docker exec ${containerName} test -f /root/.openclaw/workspace/${tf}`,
            { timeout: 5000, stdio: 'pipe' },
          );
          // File exists — skip to preserve user edits
          continue;
        } catch {
          // File does not exist — copy it
        }
        try {
          execSync(
            `docker cp ${shellQuote(src)} ${containerName}:/root/.openclaw/workspace/`,
            { timeout: 10000, stdio: 'pipe' },
          );
        } catch (cpErr) {
          console.warn(`[create] Failed to copy ${tf} to ${containerName}:`, redactedMessage(cpErr, agentsToken));
        }
      }

      // Read, change and write openclaw.json under the agent's config lock, so no patch
      // (credentials, subscriptions) can land between the read and the write and be lost.
      await withAgentConfigLock(containerName, async () => {
        // Read the config OpenClaw generated on first boot
        const raw = execSync(
          `docker exec ${containerName} cat /root/.openclaw/openclaw.json`,
          { timeout: 8000, encoding: 'utf-8', stdio: 'pipe' },
        ).trim();
        const config = JSON.parse(raw);

        // Merge all required sections in one pass (one write; the Gateway reloads the file by itself)

        // controlUi — keep what the image and OpenClaw wrote, and apply the browser-origin
        // policy so the Control UI opens on whatever host the agent is reached on.
        // Recreate re-applies the same policy through applyRuntimeConfig.
        const gatewaySection = (config.gateway || {}) as Record<string, unknown>;
        gatewaySection.controlUi = withControlUiPolicy(gatewaySection.controlUi);
        config.gateway = gatewaySection;

        const agents = (config.agents || {}) as Record<string, unknown>;
        const defaults = (agents.defaults || {}) as Record<string, unknown>;
        if (modelSetup.kind === 'model') {
          // Always the canonical `rev4a/<provider>/<model>`: the Agents chips and the
          // Model panel look the primary up by catalogue id, so the alias form
          // (`rev4a/deepseek-flash`) or a bare name would show as not in the catalogue.
          const modelRef = toRev4aRef(modelSetup.model);
          const fallbackRefs = (fallbacks || []).map((fb: string) => toRev4aRef(fb));
          defaults.model = {
            primary: modelRef,
            fallbacks: fallbackRefs.filter((fb: string) => fb !== modelRef),
          };
        } else {
          delete defaults.model;
        }
        agents.defaults = defaults;
        config.agents = agents;

        // Disable update check (agents are managed through Rev4a)
        config.update = {
          checkOnStart: false,
          auto: { enabled: false },
        };

        // Merge model + update + gateway settings (create-specific, not in applyRuntimeConfig)

        // Single write
        execSync(
          `docker exec -i ${containerName} sh -c 'cat > /root/.openclaw/openclaw.json'`,
          { timeout: 15000, input: JSON.stringify(config, null, 2), stdio: 'pipe' },
        );
      });

      // No restart: the Gateway watches openclaw.json and reloads it by itself
      // (it logs "[reload] ..."), and gateway.controlUi is hot-applied. The
      // "openclaw gateway restart" command does nothing inside a container (no systemd).
    } catch (e: unknown) {
      // post-creation config is non-fatal; can be synced manually. Parse and type errors quote the
      // openclaw.json they read, which holds credentials: log the error kind and exit code only.
      console.error(`[agent:create] post-creation config failed: ${configErrorSummary(e)}; openclaw.json was not updated.`);
    }

    // Guarantee Rev4a runtime config (hooks, shared-skills, provider).
    // These patches are idempotent deep-merges — applied AFTER the
    // create-specific config so they're always present regardless of
    // what was in the persistent volume.
    try {
      await applyRuntimeConfig(containerName);

      // Also guarantee models.providers.rev4a (host-dependent, not in base image).
      // Like the full-file write above, this needs no restart: the Gateway
      // reloads openclaw.json by itself.
      if (readProviderKeys().rev4a) {
        await patchRev4aProvider(containerName);
      } else {
        console.log('[agent:create] The Rev4a provider block will be written when the first Gateway key is saved.');
      }
    } catch (e: unknown) {
      // runtime config patch is best-effort; log but don't fail the create
      console.error('[agent:create] runtime config patch failed:', configErrorSummary(e));
    }

    finished = true;
    if (process.env.REV4A_DOMAIN?.trim()) {
      void import('@/lib/domain-sync').then(({ syncDomainRoutes }) => syncDomainRoutes())
        .catch(() => console.warn('[domain] Could not load Caddy sync.'));
    }
    return NextResponse.json({
      success: true,
      containerId,
      containerName,
      displayName: displayName.trim(),
      image,
      network,
      port: portStart,
      portEnd,
      isBlock,
      portDisplay: isBlock ? `${portStart}-${portEnd}` : String(portStart),
      noModel,
    });
  } catch (e: unknown) {
    let removed = '';
    if (rollbackTarget && !finished) {
      removed = ' ' + rollbackCreate(rollbackTarget);
      rollbackTarget = null;
    }
    const error = redactSecret(redactSecret((e as Error).message || 'Unknown error', createToken), laterToken) + removed;
    if (e instanceof AgentResourceRefusedError) {
      return NextResponse.json({ success: false, error, code: e.code, resources: e.breakdown }, { status: 409 });
    }
    return NextResponse.json({ success: false, error }, { status: 500 });
  } finally {
    releaseTokenLock();
    releaseResources();
  }
}

/**
 * Undo a create that failed after `docker run` was attempted: remove the container and, when this
 * request created it (it did not exist before the run), its data volume. Returns the sentence for the
 * error message. Best effort and logged; a volume that existed before is never touched.
 */
function rollbackCreate(t: { container: string; volume: string; volumeExisted: boolean }): string {
  let containerGone = false;
  try { execFileSync('docker', ['rm', '-f', t.container], { stdio: 'ignore', timeout: 30000 }); containerGone = true; } catch { /* best-effort */ }
  // Whatever happens next, the cached volume list (5 minutes) is out of date: the System page must see a kept volume at its next poll.
  invalidateVolumesCache();
  if (!containerGone) {
    console.warn(`[agent:create] rollback: could not remove container ${t.container}; its volume ${t.volume} was left in place`);
    return 'The new container could not be removed; remove it and its data from the Containers page.';
  }
  if (t.volumeExisted) {
    console.log(`[agent:create] rollback: removed container ${t.container}; volume ${t.volume} existed before this request and was kept`);
    return 'The container was removed.';
  }
  if (removeVolume(t.volume)) {
    console.log(`[agent:create] rollback: removed container ${t.container} and volume ${t.volume}`);
    return 'The agent and its data were removed.';
  }
  console.warn(`[agent:create] rollback: removed container ${t.container}; could not remove volume ${t.volume}`);
  return 'The container was removed, but its data volume could not be; delete it from the System page (Orphan agent volumes).';
}

/** Architecture of the image and of the Docker host, from the Docker API; null when unknown. */
async function readArchitectures(image: string): Promise<{ imageArch: string | null; hostArch: string | null }> {
  const [img, info] = await Promise.all([
    dockerGet<{ Architecture?: string }>(`/images/${encodeURIComponent(image)}/json`).catch(() => null),
    dockerGet<{ Architecture?: string }>('/info').catch(() => null),
  ]);
  return { imageArch: img?.Architecture ?? null, hostArch: info?.Architecture ?? null };
}

/** `rev4a/<provider>/<model>`, whatever form the request used. */
function toRev4aRef(modelId: string): string {
  const { provider, model } = extractProviderAndModel({ model: modelId });
  return `rev4a/${provider}/${model}`;
}

function getAvailableTemplates(): string[] {
  try {
    return fs.readdirSync(TEMPLATES_DIR).filter((f) => {
      const p = path.join(TEMPLATES_DIR, f);
      return f !== 'base-image' && f !== 'README.md' && fs.statSync(p).isDirectory();
    });
  } catch {
    return [];
  }
}

/**
 * The model must be one this deployment offers, in any form the proxy accepts.
 * Checking the raw catalogue let the API create an agent on a disabled model, or
 * one whose provider has no key, which the proxy then refuses on its first turn.
 */
function isValidModel(modelId: string): boolean {
  const { provider, model } = extractProviderAndModel({ model: modelId });
  return isModelOffered(provider, model);
}

function ensureNetworkExists(name: string): void {
  try {
    execFileSync('docker', ['network', 'inspect', name], { stdio: 'ignore', timeout: 5000 });
  } catch {
    try {
      execFileSync('docker', ['network', 'create', name], { stdio: 'ignore', timeout: 10000 });
    } catch { /* let docker run report it */ }
  }
}

function getNetwork(): string {
  try {
    const networks = execSync(
      `docker network ls --format '{{.Name}}' | grep -E '^openclaw.*'`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim().split('\n').filter(Boolean);
    return networks[0] || DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}
