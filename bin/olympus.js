#!/usr/bin/env node
/**
 * Olympus CLI — Dashboard for monitoring OpenClaw agents
 *
 * Usage:
 *   olympus serve [--port <port>]   Start everything (default)
 *   olympus build                   Manual build
 *   olympus --help / --version      Info
 *
 * olympus serve:
 *   1. Ensures .env exists (auto-generates on first run)
 *   2. Ensures .next build exists (builds if missing)
 *   3. Ensures Docker is installed (installs if missing + root)
 *   4. Ensures agent base image is built (builds if missing)
 *   5. Starts Next.js + daemon + terminal WS as a single process group
 *
 * Graceful shutdown on Ctrl+C / SIGTERM stops all children cleanly.
 */

const { spawn, execSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = join(__dirname, '..');
const NEXT_DIR = join(ROOT, '.next');
const PKG_JSON = join(ROOT, 'package.json');
const DATA_DIR = join(ROOT, 'data');
// .env lives in data/ for persistence across container recreates,
// then copied to ROOT/.env on startup for Next.js (reads from cwd root)
const ENV_SOURCE = join(DATA_DIR, '.env');
const ENV_LINK = join(ROOT, '.env');
const DOCKERFILE = join(ROOT, 'agent-templates', 'base-image', 'Dockerfile');
const AGENT_IMAGE = 'openclaw-agent-base:latest';
const AGENT_IMAGE_REGISTRY = 'ghcr.io/flame0510/olympus/openclaw-agent-base:latest';
const DOCKER_NETWORK = 'olympus-network';

let pkg;
try { pkg = require(PKG_JSON); } catch { pkg = { version: '0.0.0' }; }

const DEFAULT_PORT = 3740;

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function randomString(len) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRoot() {
  return process.getuid && process.getuid() === 0;
}

function isLinux() {
  return os.platform() === 'linux';
}

function hasCmd(name) {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function whichDistro() {
  if (!isLinux()) return null;
  try {
    const id = execSync(
      '. /etc/os-release 2>/dev/null && echo "${ID:-}"',
      { shell: '/bin/bash' }
    ).toString().trim();
    return id || null;
  } catch {
    return null;
  }
}

// ── Docker auto-install ─────────────────────────────────────────────────────

function ensureDocker() {
  if (hasCmd('docker')) {
    log('DOCKER', 'Docker is available');
    return;
  }

  if (!isLinux()) {
    log('DOCKER', '⚠ Docker not found. Olympus needs Docker to create agent containers.');
    log('DOCKER', '  Install Docker: https://docs.docker.com/get-docker/');
    log('DOCKER', '  Then run: olympus serve');
    return;
  }

  if (!isRoot()) {
    log('DOCKER', '⚠ Docker not found. Run Olympus as root to auto-install:');
    log('DOCKER', '  sudo olympus serve');
    return;
  }

  const distro = whichDistro();
  log('DOCKER', `Installing Docker (distro: ${distro || 'unknown'})…`);

  try {
    execSync('apt-get update -qq && apt-get install -y -qq curl gnupg lsb-release ca-certificates', {
      stdio: 'inherit',
      timeout: 120_000,
    });

    // Docker's official convenience script (fastest path)
    execSync(
      'curl -fsSL https://get.docker.com | sh',
      { stdio: 'inherit', timeout: 180_000 },
    );

    log('DOCKER', 'Docker installed successfully');
  } catch (err) {
    log('DOCKER', '⚠ Docker auto-install failed. Install manually:');
    log('DOCKER', '  https://docs.docker.com/engine/install/');
    log('DOCKER', '  Then run: olympus serve');
  }
}

// ── Agent image auto-pull ───────────────────────────────────────────────────

function ensureAgentImage() {
  if (!hasCmd('docker')) return; // Docker not available — skip, warn later

  // Check if image already exists locally
  try {
    const r = execSync(
      `docker image inspect ${AGENT_IMAGE} --format '{{.Id}}'`,
      { stdio: 'pipe', timeout: 10_000 },
    );
    if (r.toString().trim()) {
      log('IMAGE', `Agent base image ${AGENT_IMAGE} already exists`);
      return;
    }
  } catch {
    // Image doesn't exist locally
  }

  log('IMAGE', `Pulling agent base image from ${AGENT_IMAGE_REGISTRY}…`);

  try {
    execSync(`docker pull ${AGENT_IMAGE_REGISTRY}`, {
      stdio: 'inherit',
      timeout: 300_000, // 5 min timeout
    });
    // Tag locally for Olympus internal use
    execSync(`docker tag ${AGENT_IMAGE_REGISTRY} ${AGENT_IMAGE}`, {
      stdio: 'inherit',
      timeout: 10_000,
    });
    log('IMAGE', `Agent base image pulled and tagged as ${AGENT_IMAGE}`);
  } catch {
    log('IMAGE', `⚠ Pull from registry failed — attempting local build as fallback…`);

    if (!existsSync(DOCKERFILE)) {
      log('IMAGE', `⚠ Agent base image Dockerfile not found at ${DOCKERFILE}`);
      log('IMAGE', '  Agent creation will be unavailable until the image is available.');
      return;
    }

    log('IMAGE', `Building agent base image ${AGENT_IMAGE} (this will take a few minutes)…`);
    log('IMAGE', '  → pulling node:24-bookworm-slim + installing OpenClaw + tooling');

    try {
      execSync(`docker build -t ${AGENT_IMAGE} -f "${DOCKERFILE}" "${join(DOCKERFILE, '..')}"`, {
        stdio: 'inherit',
        timeout: 600_000, // 10 min timeout
      });
      log('IMAGE', `Agent base image ${AGENT_IMAGE} built successfully`);
    } catch {
      log('IMAGE', '⚠ Agent base image build failed. Check the logs above.');
      log('IMAGE', '  You can rebuild later via the Olympus UI or:');
      log('IMAGE', `  docker build -t ${AGENT_IMAGE} -f "${DOCKERFILE}" "${join(DOCKERFILE, '..')}"`);
    }
  }
}

// ── .env loading ───────────────────────────────────────────────────────────

/** Load OLYMPUS_* vars from the persistent .env file into an object. */
function loadEnv() {
  const vars = {};
  // Try persistent source first (data/.env), fallback to root .env
  const envPath = existsSync(ENV_SOURCE) ? ENV_SOURCE : (existsSync(ENV_LINK) ? ENV_LINK : null);
  if (!envPath) return vars;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^(OLYMPUS_\w+)=(.*)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
  } catch { /* ignore */ }
  return vars;
}

// ── .env auto-generation ────────────────────────────────────────────────────

function ensureEnv() {
  // If root .env exists (dev mode / local), just ensure data/.env also exists
  if (existsSync(ENV_LINK) && !existsSync(ENV_SOURCE)) {
    try { require('fs').copyFileSync(ENV_LINK, ENV_SOURCE); } catch {}
  }

  // If persistent .env already exists, copy it to root for Next.js
  if (existsSync(ENV_SOURCE)) {
    if (!existsSync(ENV_LINK)) {
      try { require('fs').copyFileSync(ENV_SOURCE, ENV_LINK); } catch {}
    }
    return;
  }

  // No .env at all — generate fresh
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const jwtSecret = randomString(48);
  const token = randomString(32);

  // Write to persistent location first, then copy to root
  const content = [
    '# Olympus environment — auto-generated on first run',
    `# Generated: ${new Date().toISOString()}`,
    '#',
    '# Dashboard login password (set via setup wizard on first visit)',
    'OLYMPUS_PASSWORD=',
    '',
    '# API token (programmatic access + Control UI bootstrap + Gateway master key)',
    `OLYMPUS_TOKEN=${token}`,
    `OLYMPUS_API_KEY=${token}`,
    '',
    '# JWT signing secret (session cookies)',
    `OLYMPUS_JWT_SECRET=${jwtSecret}`,
    '',
    '# Path to the events database',
    `# OLYMPUS_DB=${join(ROOT, 'data', 'events.db')}`,
    '',
    '# Provider API keys (add via the Gateway UI)',
    '# PROVIDER_OPENAI_KEY=',
    '# PROVIDER_ANTHROPIC_KEY=',
    '# PROVIDER_DEEPSEEK_KEY=',
    '# PROVIDER_OPENROUTER_KEY=',
    '# PROVIDER_GROQ_KEY=',
    '# PROVIDER_CODEX_KEY=',
    '',
  ].join('\n') + '\n';

  writeFileSync(ENV_SOURCE, content, { mode: 0o600 });
  require('fs').copyFileSync(ENV_SOURCE, ENV_LINK);

  // Sync token to agents-token.json so Gateway auth and agent bootstrap use the same key
  const agentsTokenPath = join(DATA_DIR, 'agents-token.json');
  if (!existsSync(agentsTokenPath)) {
    const agentsToken = { token, updated_at: Date.now() };
    writeFileSync(agentsTokenPath, JSON.stringify(agentsToken, null, 2), { mode: 0o600 });
    log('ENV', 'agents-token.json synced with OLYMPUS_TOKEN');
  }

  log('ENV', '.env auto-generated with JWT secret and API token');
  log('ENV', 'Set your admin password via the web setup wizard on first visit.');
}

// ── Build ───────────────────────────────────────────────────────────────────

function build() {
  log('BUILD', 'Building Olympus…');
  execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
  log('BUILD', 'Build complete.');
}

// ── Docker network ─────────────────────────────────────────────────────────

function ensureNetwork() {
  if (!hasCmd('docker')) return;

  try {
    const exists = execSync(
      `docker network ls --format '{{.Name}}'`,
      { stdio: 'pipe', timeout: 5_000 },
    ).toString().split('\n').includes(DOCKER_NETWORK);

    if (exists) {
      log('NETWORK', `Docker network '${DOCKER_NETWORK}' exists`);
      return;
    }
  } catch { /* fall through to create */ }

  log('NETWORK', `Creating Docker network '${DOCKER_NETWORK}'…`);

  try {
    execSync(`docker network create ${DOCKER_NETWORK}`, {
      stdio: 'inherit',
      timeout: 15_000,
    });
    log('NETWORK', `Docker network '${DOCKER_NETWORK}' created`);
  } catch {
    log('NETWORK', `⚠ Failed to create Docker network '${DOCKER_NETWORK}'`);
  }
}

// ── Pre-flight checks ──────────────────────────────────────────────────────

function preflight() {
  log('PREFLIGHT', 'Running pre-flight checks…');
  ensureEnv();
  ensureDocker();
  ensureNetwork();
  ensureAgentImage();

  if (!existsSync(NEXT_DIR)) {
    log('PREFLIGHT', 'No build found — running build first…');
    build();
  }
}

// ── Serve (start all 3 processes) ───────────────────────────────────────────

// ── Version check ──────────────────────────────────────────────────────────

function checkVersion() {
  try {
    const current = pkg.version || '0.0.0';
    const latest = execSync(
      'npm view @flame0510/olympus version --registry https://registry.npmjs.org 2>/dev/null',
      { stdio: 'pipe', timeout: 10_000 },
    ).toString().trim();

    if (latest && latest !== current) {
      console.log('');
      console.log('  ╔═══════════════════════════════════════════════╗');
      console.log('  ║  🆕 Olympus update available!                 ║');
      console.log(`  ║  Installed: v${current.padEnd(33)}║`);
      console.log(`  ║  Latest:    v${latest.padEnd(33)}║`);
      console.log('  ║                                               ║');
      console.log('  ║  Run: npm install -g @flame0510/olympus          ║');
      console.log('  ║  Then: restart olympus                          ║');
      console.log('  ╚═══════════════════════════════════════════════╝');
      console.log('');
    }
  } catch {
    // No internet or npm not configured — skip silently
  }
}

// ── Serve (start all 3 processes) ───────────────────────────────────────────

function serve(port) {
  checkVersion();
  preflight();

  // Load .env vars so child processes (especially Next.js) can read OLYMPUS_*
  // at runtime. process.env may not have them if olympus serve was started
  // without the vars already exported in the shell.
  const envVars = loadEnv();
  const childEnv = {
    ...process.env,
    ...envVars,
    PORT: String(port),
    NODE_ENV: 'production',
  };

  const children = [];
  const wsPort = process.env.TERMINAL_WS_PORT || '3741';

  log('SERVE', `Starting Olympus on port ${port}…`);

  // Next.js
  const next = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: childEnv,
  });
  children.push(next);
  log('SERVE', `Next.js PID ${next.pid}`);

  // Daemon
  const daemon = spawn(process.execPath, ['daemon.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: childEnv,
  });
  children.push(daemon);
  log('SERVE', `Daemon PID ${daemon.pid}`);

  // Terminal WebSocket
  const ws = spawn(process.execPath, ['terminal-ws-server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...childEnv, TERMINAL_WS_PORT: wsPort },
  });
  children.push(ws);
  log('SERVE', `Terminal WS PID ${ws.pid}`);

  // Graceful shutdown — kill all children on SIGTERM/SIGINT
  let shuttingDown = false;
  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('SERVE', `${signal} — stopping all services…`);
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch {}
    }
    // Force kill after 8s if any child survives
    setTimeout(() => {
      for (const child of children) {
        try { child.kill('SIGKILL'); } catch {}
      }
      process.exit(0);
    }, 8000);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  // Wait for all children to exit
  let exited = 0;
  for (const child of children) {
    child.on('exit', (code) => {
      exited++;
      log(child.spawnfile, `Exited (code ${code})`);
      if (exited >= children.length) process.exit(0);
    });
  }

  // Print URL after a short delay (give Next.js time to bind)
  setTimeout(() => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        Olympus is running            ║');
    console.log(`  ║        http://localhost:${String(port).padEnd(5)}     ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
  }, 3000);
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

const HELP_TEXT = `
Olympus v${pkg.version} — Agency Monitor Dashboard

USAGE:
  olympus serve [--port <port>]   Start all services (default)
  olympus build                   Build the Next.js app
  olympus --help / --version      Show help or version

EXAMPLES:
  olympus serve                    → http://localhost:3740
  olympus serve --port 8080        → http://localhost:8080

On first run, olympus serve automatically:
  • Generates .env (JWT secret + API token)
  • Installs Docker if missing (requires root)
  • Builds the agent base image (openclaw-agent-base:latest)
  • Builds the Next.js app if no build is found
  • Starts Next.js, daemon, and terminal WebSocket as a single process group
  • Cleanly stops all services on Ctrl+C / SIGTERM

CONFIGURATION:
  All settings live in .env (auto-generated on first run).
  Set your admin password via the web setup wizard at first visit.
`;

if (!cmd || cmd === 'serve') {
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : (parseInt(process.env.PORT, 10) || DEFAULT_PORT);
  serve(port);
  return; // keep event loop alive (children keep it open)
}

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(`olympus v${pkg.version}`);
  process.exit(0);
}

if (cmd === 'build') {
  ensureEnv();
  build();
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
console.error('Run olympus --help for usage.');
process.exit(1);
