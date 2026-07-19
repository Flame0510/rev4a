import { NextResponse, type NextRequest } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { syncAgent } from '../../gateway/sync';
import { detectPublicHost } from '@/lib/docker-utils';

/**
 * Wait for a Docker container gateway to be ready.
 * Checks that the gateway is responding on port 3000 inside the container.
 * Polls every 2s, gives up after timeoutMs.
 * Returns true if the gateway is reachable, false on timeout.
 */
function waitForContainerReady(name: string, timeoutMs = 20000): boolean {
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
 * Find an available host port starting from 3000.
 */
function findAvailablePort(): number {
  try {
    const usedPorts = execSync(
      `docker ps --format '{{.Ports}}' | grep -oP '\d+(?=->)' | sort -n`,
      { encoding: 'utf-8', timeout: 3000 },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);

    let candidate = 3000;
    while (usedPorts.includes(candidate)) {
      candidate++;
    }
    return candidate;
  } catch {
    return 3000;
  }
}

export const dynamic = 'force-dynamic';

const TEMPLATES_DIR = path.join(process.cwd(), 'agent-templates');
const MODELS_CONFIG = path.join(process.cwd(), 'models.config.json');
const AGENTS_TOKEN_PATH = path.join(process.cwd(), 'data', 'agents-token.json');
const DEFAULT_NETWORK = 'openclaw-core_default';

function isDockerCompatibleName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function validateName(name: string): string | null {
  if (!name || name.length < 1) return 'Name is required';
  if (name.length > 64) return 'Name must be 64 characters or fewer';
  if (!isDockerCompatibleName(name)) {
    return 'Name must start with a letter or number and contain only letters, numbers, dots, hyphens, and underscores';
  }
  return null;
}

interface CreateBody {
  name: string;
  template: string;
  port?: number;
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

    const { name, template, port: portInput, model, fallbacks } = body;
    let port = portInput;

    // Validate name
    const nameError = validateName(name);
    if (nameError) {
      return NextResponse.json(
        { success: false, error: nameError },
        { status: 400 },
      );
    }

    // Validate template exists
    const templateDir = path.join(TEMPLATES_DIR, template);
    if (!template || !fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
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
      `docker ps --filter "label=AGENT_ID=${name}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Agent '${name}' is already running (container: ${existing})` },
        { status: 409 },
      );
    }

    // Check if port is already in use
    if (port) {
      if (port < 1 || port > 65535) {
        return NextResponse.json(
          { success: false, error: 'Port must be between 1 and 65535' },
          { status: 400 },
        );
      }
      const portInUse = execSync(
        `docker ps --format '{{.Ports}}' | grep -oP '\d+(?=->)' | grep -Fx '${port}' || true`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (portInUse) {
        return NextResponse.json(
          { success: false, error: `Port ${port} is already in use` },
          { status: 409 },
        );
      }
    }

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

    // Every agent gets a host port for direct access (http://<ip>:<port>).
    // Traefik domain routing is optional and configured externally by the operator.
    if (!port) {
      port = findAvailablePort();
    }
    const agentHostname = `${detectPublicHost()}:${port}`;
    const traefikUrl = `http://${agentHostname}#token=${encodeURIComponent(agentsToken)}`;

    const labels: string[] = [`AGENT_ID=${name}`];
    const envVars: string[] = [
      `AGENT_ID=${name}`,
      `AGENT_NAME=${name}`,
      `OPENCLAW_GATEWAY_TOKEN=${agentsToken}`,
      `AGENT_HOSTNAME=${agentHostname}`,
      `TZ=Europe/Rome`,
    ];

    // Pass the selected model to the entrypoint so it writes it at first boot
    if (model) {
      envVars.push(`OPENCLAW_MODEL_PRIMARY=${model}`);
    }

    const labelOpts = labels.map((l) => `-l ${shellQuote(l)}`).join(' ');
    const envOpts = envVars.map((e) => `-e ${shellQuote(e)}`).join(' ');
    const portOpt = `-p ${port}:3000`;

    // Template files that will be copied into the container workspace.
    // Files that don't exist in the template dir are silently skipped —
    // this is intentional (e.g. BOOTSTRAP.md only exists in custom/).
    const templateFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];

    const cmd = `docker run -d \
      --name "${name}" \
      --network "${network}" \
      --restart unless-stopped \
      --add-host host.docker.internal:host-gateway \
      -v agent-${name}-data:/root \
      ${labelOpts} \
      ${envOpts} \
      ${portOpt} \
      "${image}"`;

    const result = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    const containerId = result.trim();

    // Log event to events.db if it exists
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(process.cwd(), 'data', 'events.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.prepare(
          `INSERT INTO events (ts, session_id, type, data) VALUES (?, ?, ?, ?)`,
        ).run(Date.now(), `system:agents`, 'agent_created', JSON.stringify({
          name,
          template,
          port,
          model: model || 'olympus/deepseek-v4-flash',
          fallbacks,
          containerId,
          containerName: name,
        }));
        db.close();
      }
    } catch {
      // DB logging is optional, ignore failures
    }

    // Wait for container to be ready (HTTP health check)
    const ready = waitForContainerReady(name);
    if (ready) {
      try {
        // Create workspace dir (OpenClaw does not create it automatically if
        // agents.defaults.workspace is not configured).
        execSync(
          `docker exec ${name} mkdir -p /root/.openclaw/workspace`,
          { timeout: 10000, stdio: 'pipe' },
        );

        // Check if the workspace already has template files (persisted from a
        // previous container via the agent-<name>-data volume). If so, skip the
        // copy — the user may have edited them.
        // Copy template files into the container (NOT bind-mount, so agent edits
        // never spill back to the Olympus repo). Always copy — templates are
        // the canonical source of truth for a new agent.
        for (const tf of templateFiles) {
          const src = path.join(templateDir, tf);
          if (fs.existsSync(src) && fs.statSync(src).isFile()) {
            try {
              execSync(
                `docker cp ${shellQuote(src)} ${name}:/root/.openclaw/workspace/`,
                { timeout: 10000, stdio: 'pipe' },
              );
            } catch (cpErr) {
              console.warn(`[create] Failed to copy ${tf} to ${name}:`, (cpErr as Error).message);
            }
          }
        }

        // Step 1: Read current config (OpenClaw has already written its default)
        const raw = execSync(
          `docker exec ${name} cat /root/.openclaw/openclaw.json`,
          { timeout: 8000, encoding: 'utf-8' },
        ).trim();
        const config = JSON.parse(raw);

        // Step 2: Seed controlUi.allowedOrigins for browser Control UI access.
        // Must be done after OpenClaw's first boot since OpenClaw discards it.
        // Allow all origins — agents are protected by the gateway token anyway.
        const gatewaySection = (config.gateway || {}) as Record<string, unknown>;
        gatewaySection.controlUi = {
          allowedOrigins: ['*'],
          dangerouslyDisableDeviceAuth: true,
        };
        config.gateway = gatewaySection;

        // Step 3: Set primary model reference if provided by the wizard
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

        // Step 3b: Disable update check
        // Agents are managed through Olympus (rebuild image + recreate container),
        // not through `openclaw update`. Suppress the "Update Available" banner
        // in the Control UI and the startup update hint.
        config.update = {
          checkOnStart: false,
          auto: { enabled: false },
        };

        // Write the merged config back
        execSync(
          `docker exec -i ${name} sh -c 'cat > /root/.openclaw/openclaw.json'`,
          { timeout: 15000, input: JSON.stringify(config, null, 2) },
        );

        // Step 4: Sync provider config (models.providers.olympus)
        // This is done AFTER writing controlUi + model ref so syncAgent's
        // readContainerJson sees a stable config with gateway section intact
        try {
          syncAgent(name);
        } catch {
          // sync failure is non-fatal; models can be synced manually from Gateway page
        }
      } catch {
        // post-creation config is non-fatal; can be synced manually
      }
    }

    return NextResponse.json({
      success: true,
      containerId,
      name,
      image,
      network,
      traefikUrl,
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
