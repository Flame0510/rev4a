import { NextResponse, type NextRequest } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildOlympusProviderConfig } from '../../gateway/sync';
import { detectPublicHost } from '@/lib/docker-utils';
import { DB_FILE, AGENTS_TOKEN_FILE, MODELS_CONFIG_FILE, PROVIDER_KEYS_FILE, templatesDir } from '@/lib/olympus-paths';
import { getMountFlags, applyRuntimeConfig } from '@/lib/agent-setup';

/**
 * Wait for a Docker container gateway to be ready.
 * Checks that the gateway is responding on port 3000 inside the container.
 * Polls every 2s, gives up after timeoutMs.
 * Returns true if the gateway is reachable, false on timeout.
 */
function waitForContainerReady(name: string, timeoutMs = 60000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(
        `docker exec ${name} sh -c 'curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1 || wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1'`,
        { timeout: 5000 },
      );
      return true;
    } catch {
      // gateway not ready yet
    }
    // Sleep 2s
    execSync('sleep 2', { timeout: 3000 });
  }
  return false;
}



/**
 * Find an available host port block starting from 3700.
 */
const OLYMPUS_PORT = 3740;
const DEFAULT_BLOCK_SIZE = 10;

function getUsedHostPorts(): Set<number> {
  try {
    const raw = execSync(
      `docker ps --format '{{.Ports}}' | grep -oP '\d+(?=->)' | sort -n`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return new Set(raw ? raw.split('\n').map(Number) : []);
  } catch {
    return new Set();
  }
}

function findAvailablePortBlock(blockSize = DEFAULT_BLOCK_SIZE): number {
  const usedPorts = getUsedHostPorts();
  for (let base = 3700; base + blockSize - 1 <= 3799; base += DEFAULT_BLOCK_SIZE) {
    if (base <= OLYMPUS_PORT && OLYMPUS_PORT <= base + blockSize - 1) continue;
    const block = Array.from({ length: blockSize }, (_, i) => base + i);
    if (block.every((p) => !usedPorts.has(p))) return base;
  }
  let base = 3800;
  while (true) {
    const block = Array.from({ length: blockSize }, (_, i) => base + i);
    if (block.every((p) => !usedPorts.has(p))) return base;
    base += DEFAULT_BLOCK_SIZE;
  }
}

function validatePortInput(input: string): { valid: true; isBlock: boolean; start: number; end: number } | { valid: false; error: string } {
  const trimmed = input.trim();
  if (trimmed.includes('-')) {
    const m = trimmed.match(/^(\d{1,5})-(\d{1,5})$/);
    if (!m) return { valid: false, error: 'Invalid format. Use e.g. 3700-3709' };
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start < 1 || end > 65535) return { valid: false, error: 'Ports must be between 1 and 65535' };
    if (end <= start) return { valid: false, error: 'End port must be greater than start port' };
    if (start <= OLYMPUS_PORT && OLYMPUS_PORT <= end) return { valid: false, error: `Port ${OLYMPUS_PORT} is reserved for Olympus` };
    const usedPorts = getUsedHostPorts();
    const conflicts: number[] = [];
    for (let p = start; p <= end; p++) { if (usedPorts.has(p)) conflicts.push(p); }
    if (conflicts.length > 0) return { valid: false, error: `Ports already in use: ${conflicts.join(', ')}` };
    return { valid: true, isBlock: true, start, end };
  }
  const m = trimmed.match(/^(\d{1,5})$/);
  if (!m) return { valid: false, error: 'Use a number (e.g. 3700) or a range (e.g. 3700-3709)' };
  const port = parseInt(m[1], 10);
  if (port < 1 || port > 65535) return { valid: false, error: 'Port must be between 1 and 65535' };
  if (port === OLYMPUS_PORT) return { valid: false, error: `Port ${OLYMPUS_PORT} is reserved for Olympus` };
  const usedPorts = getUsedHostPorts();
  if (usedPorts.has(port)) return { valid: false, error: `Port ${port} is already in use` };
  return { valid: true, isBlock: false, start: port, end: port };
}

export const dynamic = 'force-dynamic';
export const maxDuration = 180; // docker run (60s) + health check (60s) + seeding (60s)

const TEMPLATES_DIR = templatesDir(process.cwd());
const MODELS_CONFIG = MODELS_CONFIG_FILE;
const AGENTS_TOKEN_PATH = AGENTS_TOKEN_FILE;
const DEFAULT_NETWORK = 'olympus-network';

function isDockerCompatibleName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function generateContainerName(): string {
  const hex = require('crypto').randomBytes(4).toString('hex');
  return `agent_${hex}`;
}

interface CreateBody {
  name: string;
  template: string;
  portRange?: string;
  model?: string;
  fallbacks?: string[];
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

    const { name: displayName, template, portRange: portInput, model, fallbacks } = body;

    // Validate display name
    if (!displayName || displayName.trim().length < 1) {
      return NextResponse.json(
        { success: false, error: 'Agent name is required' },
        { status: 400 },
      );
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

    // Validate model (if provided) exists in models.config.json
    if (model && !isValidModel(model)) {
      return NextResponse.json(
        { success: false, error: `Model '${model}' not found in models.config.json` },
        { status: 400 },
      );
    }

    // Check if name is already in use by a running container
    const existing = execSync(
      `docker ps --filter "label=AGENT_ID=${containerName}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Agent '${displayName}' is already running (container: ${existing})` },
        { status: 409 },
      );
    }

    // Resolve port range
    let isBlock = false;
    let portStart: number = 0;
    let portEnd: number = 0;

    if (portInput) {
      const v = validatePortInput(portInput);
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
      portStart = findAvailablePortBlock();
      portEnd = portStart + DEFAULT_BLOCK_SIZE - 1;
      isBlock = true;
    }

    // Ensure shared volumes exist (created by olympus serve preflight, defensive guard here)
    const mountFlags = getMountFlags();

    // Build docker run command
    const image = 'openclaw-agent-base:latest';
    const network = getNetwork();

    // Read agents token for new containers
    const agentsToken = readAgentsToken();
    if (!agentsToken) {
      return NextResponse.json(
        { success: false, error: 'Agents gateway token is missing. Set it from /agents before creating agents.' },
        { status: 400 },
      );
    }

    // Every agent gets a host port range for direct access (http://<ip>:<port>).
    const agentHostname = `${detectPublicHost()}:${portStart}`;
    const traefikUrl = `http://${agentHostname}#token=${encodeURIComponent(agentsToken)}`;

    const labels: string[] = [`AGENT_ID=${containerName}`];
    const envVars: string[] = [
      `AGENT_ID=${containerName}`,
      `AGENT_NAME=${displayName.trim()}`,
      `AGENT_TEMPLATE=${template}`,
      `OPENCLAW_GATEWAY_TOKEN=${agentsToken}`,
      `AGENT_HOSTNAME=${agentHostname}`,
      `TZ=Europe/Rome`,
    ];

    const labelOpts = labels.map((l) => `-l ${shellQuote(l)}`).join(' ');
    const envOpts = envVars.map((e) => `-e ${shellQuote(e)}`).join(' ');
    const portOpt = isBlock
      ? `-p ${portStart}-${portEnd}:3000-${3000 + (portEnd - portStart)}`
      : `-p ${portStart}:3000`;

    // Template files that will be copied into the container workspace.
    // Files that don't exist in the template dir are silently skipped —
    // this is intentional (e.g. BOOTSTRAP.md only exists in custom/).
    const templateFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];

    const cmd = `docker run -d \
      --name "${containerName}" \
      --network "${network}" \
      --restart unless-stopped \
      --add-host host.docker.internal:host-gateway \
      -v agent-${containerName}-data:/root \
      ${mountFlags.join(' \
      ')} \
      ${labelOpts} \
      ${envOpts} \
      ${portOpt} \
      "${image}"`;

    const result = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    const containerId = result.trim();

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
          model: model || 'olympus/deepseek-v4-flash',
          fallbacks,
          containerId,
          containerName,
        }));
        db.close();
      }
    } catch {
      // DB logging is optional, ignore failures
    }

    // Wait for container to be ready (HTTP health check, up to 60s).
    // If it doesn't come up, remove the container and return an error —
    // a zombie agent with no config is worse than an explicit failure.
    const ready = waitForContainerReady(containerName);
    if (!ready) {
      try { execSync(`docker rm -f ${containerName}`, { timeout: 10000 }); } catch { /* best-effort */ }
      return NextResponse.json(
        { success: false, error: `Container started but gateway did not become healthy within 60s. Container removed — try again.` },
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
          console.warn(`[create] Failed to copy ${tf} to ${containerName}:`, (cpErr as Error).message);
        }
      }

      // Read the config OpenClaw generated on first boot
      const raw = execSync(
        `docker exec ${containerName} cat /root/.openclaw/openclaw.json`,
        { timeout: 8000, encoding: 'utf-8' },
      ).trim();
      const config = JSON.parse(raw);

      // Merge all required sections in one pass (single write, single restart)

      // controlUi — allow browser Control UI access.
      // deviceAuth is disabled because agent containers are only reachable
      // on the internal Docker network; the gateway token is the sole auth barrier.
      const gatewaySection = (config.gateway || {}) as Record<string, unknown>;
      gatewaySection.controlUi = {
        allowedOrigins: ['*'],
        dangerouslyDisableDeviceAuth: true,
      };
      config.gateway = gatewaySection;

      // Model reference (primary + fallbacks)
      if (model) {
        const modelRef = model.startsWith('olympus/') ? model : `olympus/${model}`;
        const fallbackRefs = (fallbacks || []).map((fb: string) =>
          fb.startsWith('olympus/') ? fb : `olympus/${fb}`,
        );
        const agents = (config.agents || {}) as Record<string, unknown>;
        const defaults = (agents.defaults || {}) as Record<string, unknown>;
        defaults.model = {
          primary: modelRef,
          fallbacks: fallbackRefs.filter((fb: string) => fb !== modelRef),
        };
        agents.defaults = defaults;
        config.agents = agents;
      }

      // Disable update check (agents are managed through Olympus)
      config.update = {
        checkOnStart: false,
        auto: { enabled: false },
      };

      // Merge model + update + gateway settings (create-specific, not in applyRuntimeConfig)

      // Single write
      execSync(
        `docker exec -i ${containerName} sh -c 'cat > /root/.openclaw/openclaw.json'`,
        { timeout: 15000, input: JSON.stringify(config, null, 2) },
      );

      // Single restart to pick up the merged config
      try {
        execSync(`docker exec ${containerName} openclaw gateway restart`, { timeout: 15000 });
      } catch {
        // restart failure is non-fatal; config is on disk, picked up on next boot
      }
    } catch {
      // post-creation config is non-fatal; can be synced manually
    }

    // Guarantee Olympus runtime config (hooks, shared-skills, provider).
    // These patches are idempotent deep-merges — applied AFTER the
    // create-specific config so they're always present regardless of
    // what was in the persistent volume.
    try {
      applyRuntimeConfig(containerName);

      // Also guarantee models.providers.olympus (host-dependent, not in base image)
      const providerConfig = buildOlympusProviderConfig();
      const providerJson = JSON.stringify({ models: { providers: { olympus: providerConfig } } });
      execSync(
        `docker exec -i ${containerName} sh -c 'openclaw config patch --stdin'`,
        { timeout: 15000, stdio: 'pipe', input: providerJson },
      );

      try {
        execSync(`docker exec ${containerName} openclaw gateway restart`, { timeout: 15000 });
      } catch { /* restart is best-effort */ }
    } catch {
      // runtime config patch is best-effort
    }

    return NextResponse.json({
      success: true,
      containerId,
      containerName,
      displayName: displayName.trim(),
      image,
      network,
      traefikUrl,
      port: portStart,
      portEnd,
      isBlock,
      portDisplay: isBlock ? `${portStart}-${portEnd}` : String(portStart),
    });
  } catch (e: unknown) {
    const err = e as Error;
    return NextResponse.json(
      { success: false, error: err.message || 'Unknown error' },
      { status: 500 },
    );
  }
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

function isValidModel(modelId: string): boolean {
  try {
    if (!fs.existsSync(MODELS_CONFIG)) return true; // skip validation if no config
    const raw = fs.readFileSync(MODELS_CONFIG, 'utf-8');
    const config = JSON.parse(raw);
    return config.models?.some((m: { id: string }) => m.id === modelId) ?? false;
  } catch {
    return true; // skip on errors
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
