import { NextResponse, type NextRequest } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildOlympusProviderConfig } from '../../gateway/sync';
import { detectPublicHost } from '@/lib/docker-utils';
import { DB_FILE, AGENTS_TOKEN_FILE, MODELS_CONFIG_FILE, PROVIDER_KEYS_FILE, templatesDir } from '@/lib/olympus-paths';

const OLYMPUS_PORT = 3740;
const DEFAULT_BLOCK_SIZE = 10;

function getUsedHostPorts(): Set<number> {
  try {
    const raw = execSync(
      `docker ps --format '{{.Ports}}' | grep -oP '\\d+(?=->)' | sort -n`,
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

    // Check olympus port in range
    if (start <= OLYMPUS_PORT && OLYMPUS_PORT <= end) {
      return { valid: false, error: `Port ${OLYMPUS_PORT} in range is reserved for Olympus` };
    }

    const usedPorts = getUsedHostPorts();
    const conflicts: number[] = [];
    for (let p = start; p <= end; p++) {
      if (usedPorts.has(p)) conflicts.push(p);
    }
    if (conflicts.length > 0) {
      return { valid: false, error: `Ports already in use: ${conflicts.join(', ')}` };
    }

    return { valid: true, isBlock: true, start, end };
  }

  const m = trimmed.match(/^(\d{1,5})$/);
  if (!m) return { valid: false, error: 'Invalid port. Use a number (e.g. 3700) or a range (e.g. 3700-3709)' };
  const port = parseInt(m[1], 10);
  if (port < 1 || port > 65535) return { valid: false, error: 'Port must be between 1 and 65535' };
  if (port === OLYMPUS_PORT) return { valid: false, error: `Port ${OLYMPUS_PORT} is reserved for Olympus` };

  const usedPorts = getUsedHostPorts();
  if (usedPorts.has(port)) return { valid: false, error: `Port ${port} is already in use` };

  return { valid: true, isBlock: false, start: port, end: port };
}

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const TEMPLATES_DIR = templatesDir(process.cwd());
const MODELS_CONFIG = MODELS_CONFIG_FILE;
const AGENTS_TOKEN_PATH = AGENTS_TOKEN_FILE;
const DEFAULT_NETWORK = 'olympus-network';
const SHARED_SKILLS = '/docker/shared-skills';
const SHARED_REPOS = '/docker/shared-repos';

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

function getAvailableTemplates(): string[] {
  try {
    return fs.readdirSync(TEMPLATES_DIR).filter((f) => {
      const p = path.join(TEMPLATES_DIR, f);
      return fs.statSync(p).isDirectory() && !f.startsWith('.');
    });
  } catch { return []; }
}

function isValidModel(modelId: string): boolean {
  try {
    if (fs.existsSync(MODELS_CONFIG)) {
      const raw = fs.readFileSync(MODELS_CONFIG, 'utf-8');
      const config = JSON.parse(raw);
      return (config.models || []).some((m: { id: string }) => m.id === modelId);
    }
    return false;
  } catch { return false; }
}

function getNetwork(): string {
  try {
    const nets = execSync('docker network ls --format "{{.Name}}"', { encoding: 'utf-8', timeout: 3000 });
    return nets.includes('olympus-network') ? 'olympus-network' : 'bridge';
  } catch { return 'bridge'; }
}

function isDockerCompatibleName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function validateName(name: string): string | null {
  if (!name || name.length < 1) return 'Name is required';
  if (name.length > 64) return 'Name must be 64 characters or fewer';
  if (!isDockerCompatibleName(name)) return 'Name must start with a letter/number and contain only letters, numbers, dots, hyphens, underscores';
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readAgentsToken(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(AGENTS_TOKEN_PATH, 'utf-8'));
    return typeof raw?.token === 'string' ? raw.token.trim() : '';
  } catch { return ''; }
}

interface CreateBody {
  name: string;
  template: string;
  portRange?: string;
  model?: string;
  fallbacks?: string[];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let body: CreateBody;
    try { body = await request.json(); } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { name, template, portRange: portInput, model, fallbacks } = body;

    const nameError = validateName(name);
    if (nameError) return NextResponse.json({ success: false, error: nameError }, { status: 400 });

    if (!isDockerCompatibleName(template)) {
      return NextResponse.json({ success: false, error: 'Invalid template name' }, { status: 400 });
    }

    const templateDir = path.join(TEMPLATES_DIR, template);
    if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
      return NextResponse.json({
        success: false,
        error: `Template '${template}' not found. Available: ${getAvailableTemplates().join(', ')}`,
      }, { status: 400 });
    }

    if (model && !isValidModel(model)) {
      return NextResponse.json({ success: false, error: `Model '${model}' not found in models.config.json` }, { status: 400 });
    }

    const existing = execSync(
      `docker ps --filter "label=AGENT_ID=${name}" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (existing) {
      return NextResponse.json({ success: false, error: `Agent '${name}' is already running (container: ${existing})` }, { status: 409 });
    }

    // Resolve port range
    let isBlock = false;
    let portStart: number;
    let portEnd: number;

    if (portInput) {
      const v = validatePortInput(portInput);
      if (!v.valid) return NextResponse.json({ success: false, error: v.error }, { status: 400 });
      isBlock = v.isBlock;
      portStart = v.start;
      portEnd = v.end;
    } else {
      portStart = findAvailablePortBlock();
      portEnd = portStart + DEFAULT_BLOCK_SIZE - 1;
      isBlock = true;
    }

    for (const vol of [SHARED_SKILLS, SHARED_REPOS]) {
      if (!fs.existsSync(vol)) {
        fs.mkdirSync(vol, { recursive: true });
        try { execSync(`chown 1000:1000 ${shellQuote(vol)}`, { timeout: 3000 }); } catch { /* */ }
        try { execSync(`chmod 2775 ${shellQuote(vol)}`, { timeout: 3000 }); } catch { /* */ }
      }
    }

    const agentsToken = readAgentsToken();
    if (!agentsToken) {
      return NextResponse.json({ success: false, error: 'Agents gateway token is missing. Set it from /agents before creating agents.' }, { status: 400 });
    }

    const agentHostname = `${detectPublicHost()}:${portStart}`;
    const traefikUrl = `http://${agentHostname}#token=${encodeURIComponent(agentsToken)}`;

    const labels: string[] = [`AGENT_ID=${name}`];
    const envVars: string[] = [
      `AGENT_ID=${name}`,
      `AGENT_NAME=${name}`,
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

    const templateFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];

    const cmd = `docker run -d \
      --name "${name}" \
      --network "${getNetwork()}" \
      --restart unless-stopped \
      --add-host host.docker.internal:host-gateway \
      -v agent-${name}-data:/root \
      -v ${SHARED_SKILLS}:/data/.openclaw/shared-skills:ro \
      -v ${SHARED_REPOS}:/data/repos:rw \
      ${labelOpts} \
      ${envOpts} \
      ${portOpt} \
      "${'openclaw-agent-base:latest'}"`;

    const result = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    const containerId = result.trim();

    try {
      const Database = require('better-sqlite3');
      const dbPath = DB_FILE;
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.prepare(
          `INSERT OR IGNORE INTO events (session_id, type, data, created_at) VALUES (?, ?, ?, strftime('%s','now'))`
        ).run(name, 'agent_created', JSON.stringify({ containerId, template, portStart, portEnd, isBlock }));
        db.close();
      }
    } catch { /* non-fatal */ }

    const portDisplay = isBlock ? `${portStart}-${portEnd}` : String(portStart);

    return NextResponse.json({
      success: true,
      name,
      containerId,
      traefikUrl,
      port: portStart,
      isBlock,
      portDisplay,
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return NextResponse.json(
      { success: false, error: err.stderr?.toString() || err.message || 'Unknown error' },
      { status: 500 },
    );
  }
}
