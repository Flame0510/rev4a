#!/usr/bin/env node
/**
 * Rev4a CLI — Revolution for Agents
 *
 * Usage:
 *   rev4a serve [--port <port>]   Start everything (default)
 *   rev4a build                   Manual build
 *   rev4a --help / --version      Info
 *
 * rev4a serve:
 *   1. Ensures .env exists (auto-generates on first run)
 *   2. Ensures .next build exists (builds if missing)
 *   3. Ensures Docker is installed (installs if missing + root)
 *   4. Ensures agent base image is built (builds if missing)
 *   5. Starts Next.js + daemon + terminal WS as a single process group
 *
 * rev4a serve auto-restarts when rev4a update triggers exit code 42.
 * No systemd required.
 *
 * Graceful shutdown on Ctrl+C / SIGTERM stops all children cleanly.
 */

const { spawn, execSync, spawnSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = join(__dirname, '..');
const NEXT_DIR = join(ROOT, '.next');
const PKG_JSON = join(ROOT, 'package.json');
// Config lives outside the npm package so it survives npm update / reinstall.
// REV4A_DATA_DIR must be honoured here exactly as rev4aDataDir() honours it in
// lib/rev4a-paths.ts: this file creates the shared directories that the app then
// bind-mounts into agents, so a divergence would have serve writing the system
// rules to one path while every agent mounted another — silently empty.
// It can only come from the real process environment, never from the .env file:
// that file is looked up under this very directory.
const CONFIG_DIR = process.env.REV4A_DATA_DIR || join(os.homedir(), '.config', 'rev4a');
const DATA_DIR = join(CONFIG_DIR, 'data');
const ENV_SOURCE = join(CONFIG_DIR, '.env');
const ENV_LINK = join(ROOT, '.env');
const DOCKERFILE = join(ROOT, 'agent-templates', 'base-image', 'Dockerfile');
const AGENT_IMAGE = 'openclaw-agent-base:latest';
const AGENT_IMAGE_REGISTRY = 'ghcr.io/flame0510/rev4a/openclaw-agent-base:latest';
const DOCKER_NETWORK = 'rev4a-network';

// Fallback used only when package.json cannot be read — the published npm
// package name is the single source of truth, so never hardcode it elsewhere.
const FALLBACK_PKG_NAME = '@flame0510/project-aether';

let pkg;
try { pkg = require(PKG_JSON); } catch { pkg = { version: '0.0.0', name: FALLBACK_PKG_NAME }; }

const PKG_NAME = pkg.name || FALLBACK_PKG_NAME;

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
    log('DOCKER', '⚠ Docker not found. Rev4a needs Docker to create agent containers.');
    log('DOCKER', '  Install Docker: https://docs.docker.com/get-docker/');
    log('DOCKER', '  Then run: rev4a serve');
    return;
  }

  if (!isRoot()) {
    log('DOCKER', '⚠ Docker not found. Run Rev4a as root to auto-install:');
    log('DOCKER', '  sudo rev4a serve');
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
    log('DOCKER', '  Then run: rev4a serve');
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
    // Tag locally for Rev4a internal use
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
      log('IMAGE', `Agent base image built successfully`);
    } catch {
      log('IMAGE', '⚠ Agent base image build failed. Agent creation will be unavailable.');
      log('IMAGE', '  Pull the image manually: docker pull ' + AGENT_IMAGE_REGISTRY);
    }
  }
}

// ── Docker network ──────────────────────────────────────────────────────────

function ensureNetwork() {
  if (!hasCmd('docker')) return;
  try {
    execSync(`docker network inspect ${DOCKER_NETWORK} > /dev/null 2>&1`);
    log('NETWORK', `Docker network ${DOCKER_NETWORK} exists`);
  } catch {
    log('NETWORK', `Creating Docker network ${DOCKER_NETWORK}…`);
    try {
      execSync(`docker network create ${DOCKER_NETWORK}`);
      log('NETWORK', `Network ${DOCKER_NETWORK} created`);
    } catch (err) {
      log('NETWORK', `⚠ Failed to create network: ${err.message}`);
    }
  }
}

// ── Rev4a system rules ───────────────────────────────────────────────────

function ensureRev4aRules() {
  // These must mirror SHARED_SKILLS_DIR / REV4A_RULES_DIR in lib/rev4a-paths.ts.
  // This file is CommonJS and runs before .next exists (it is what builds it),
  // so it cannot import from lib/ — same reason CONFIG_DIR is recomputed above.
  //
  // It previously tried `require('.next/server/lib/agent-setup.js')` to reuse
  // ensureHostDirs(). Next bundles route code and never emits that path, so the
  // require always threw into an empty catch and the directories were never
  // created here at all.
  const sharedDir = join(CONFIG_DIR, 'shared');
  const sharedSkillsDir = join(sharedDir, 'shared-skills');
  const rev4aRulesDir = join(sharedDir, 'rev4a-rules');

  try {
    mkdirSync(sharedSkillsDir, { recursive: true });
    mkdirSync(rev4aRulesDir, { recursive: true });
  } catch (err) {
    log('RULES', `⚠ Could not create shared directories: ${err.message}`);
    return;
  }

  const ruleFile = join(rev4aRulesDir, 'AGENTS.md');
  const source = join(ROOT, 'rev4a-rules', 'AGENTS.md');

  if (!existsSync(source)) {
    log('RULES', 'No rev4a-rules source found, skipping');
    return;
  }

  const sourceContent = readFileSync(source, 'utf-8');
  let deployedContent = '';
  try {
    deployedContent = existsSync(ruleFile) ? readFileSync(ruleFile, 'utf-8') : '';
  } catch { /* file doesn't exist yet */ }

  if (sourceContent === deployedContent) {
    log('RULES', 'Rev4a system rules up to date');
    return;
  }

  try {
    // Direct write — the old /tmp + `sudo cp` + `sudo rm` dance was only
    // needed because the destination sat outside the user's home.
    writeFileSync(ruleFile, sourceContent, 'utf-8');
    log('RULES', `Deployed rev4a system rules to ${rev4aRulesDir}/`);
  } catch (err) {
    log('RULES', `⚠ Failed to deploy rev4a rules: ${err.message}`);
  }
}

// ── .env setup ──────────────────────────────────────────────────────────────

function loadEnv() {
  const envFile = existsSync(ENV_SOURCE) ? ENV_SOURCE : null;
  if (!envFile) return {};

  const result = {};
  try {
    const content = readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();

      // Strip surrounding quotes (single or double)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (key) result[key] = val;
    }
  } catch (err) {
    log('ENV', `Warning: failed to read ${envFile} — ${err.message}`);
  }
  return result;
}

function ensureEnv() {
  if (existsSync(ENV_SOURCE)) {
    log('ENV', 'Configuration found');
    // Ensure symlink so the app can find .env at the root
    if (!existsSync(ENV_LINK)) {
      try { require('fs').symlinkSync(ENV_SOURCE, ENV_LINK); } catch {}
    }
    // Seed agent token file if missing
    seedAgentToken();
    return;
  }

  log('ENV', 'Generating default configuration…');

  mkdirSync(CONFIG_DIR, { recursive: true });

  const jwt = randomString(48);
  const token = randomString(32);
  const apiKey = 'rev_' + randomString(48);
  const gatewayToken = randomString(48);

  const env = [
    '# Rev4a environment — auto-generated on first run',
    `# Generated: ${new Date().toISOString()}`,
    '',
    '# Dashboard login password (set via setup wizard on first visit)',
    'REV4A_PASSWORD=',
    '',
    '# JWT secret for session tokens (auto-generated)',
    `REV4A_JWT_SECRET=${jwt}`,
    '',
    '# API token for Rev4a → agents communication (auto-generated)',
    `REV4A_TOKEN=${token}`,
    '',
    '# API key for Gateway provider endpoint (auto-generated)',
    `REV4A_API_KEY=${apiKey}`,
    '',
    '# Gateway token shared with agent containers (auto-generated)',
    `GATEWAY_TOKEN=${gatewayToken}`,
    '',
  ].join('\n') + '\n';

  writeFileSync(ENV_SOURCE, env, { mode: 0o600 });
  log('ENV', `Written ${ENV_SOURCE}`);

  // Symlink in package root so Next.js server finds it
  try { require('fs').symlinkSync(ENV_SOURCE, ENV_LINK); } catch {}

  seedAgentToken();
}

function seedAgentToken() {
  const agentsTokenPath = join(DATA_DIR, 'agents-token.json');
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(agentsTokenPath)) return;

  const envVars = loadEnv();
  const gatewayToken = envVars.GATEWAY_TOKEN || randomString(48);
  const agentsToken = { token: gatewayToken, updated_at: Date.now() };
  writeFileSync(agentsTokenPath, JSON.stringify(agentsToken, null, 2), { mode: 0o600 });
  log('ENV', 'Agent token file seeded');
}

// ── Build ───────────────────────────────────────────────────────────────────

function build() {
  log('BUILD', 'Building Next.js app…');
  try {
    execSync('npx next build', { stdio: 'inherit', cwd: ROOT, timeout: 120_000 });
    log('BUILD', 'Build complete');
  } catch (err) {
    log('BUILD', `Build failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Version check ───────────────────────────────────────────────────────────

function checkVersion() {
  try {
    const latest = execSync(
      `npm view ${PKG_NAME} version --registry https://registry.npmjs.org 2>/dev/null`,
      { stdio: 'pipe', timeout: 8000 },
    ).toString().trim();
    if (!latest || latest === pkg.version) return;

    const rows = [
      '🆕 Rev4a update available!',
      `Latest: v${latest}`,
      `Installed: v${pkg.version}`,
      '',
      `Run: npm install -g ${PKG_NAME}`,
      'Then: restart rev4a',
    ];
    // Box is sized to the longest row so the package name can change freely.
    const width = Math.max(...rows.map((r) => r.length));

    console.log('');
    console.log(`  ╔══${'═'.repeat(width)}══╗`);
    for (const row of rows) {
      console.log(`  ║  ${row}${' '.repeat(width - row.length)}  ║`);
    }
    console.log(`  ╚══${'═'.repeat(width)}══╝`);
    console.log('');
  } catch {
    // No internet or npm not configured — skip silently
  }
}

// ── Preflight ───────────────────────────────────────────────────────────────

function preflight() {
  log('PREFLIGHT', 'Running pre-flight checks…');
  ensureEnv();
  ensureDocker();
  ensureNetwork();
  ensureAgentImage();
  ensureRev4aRules();

  if (!existsSync(NEXT_DIR)) {
    log('PREFLIGHT', 'No build found — running build first…');
    build();
  }
}

// ── Serve (start all 3 processes) ───────────────────────────────────────────

function serve(port) {
  preflight();
  // Version check is non-blocking — runs after startup
  setTimeout(checkVersion, 2000);

  // Load .env vars so child processes (especially Next.js) can read REV4A_*
  // at runtime. process.env may not have them if rev4a serve was started
  // without the vars already exported in the shell.
  const envVars = loadEnv();
  const childEnv = {
    ...process.env,
    ...envVars,
    PORT: String(port),
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  const children = [];
  const wsPort = process.env.TERMINAL_WS_PORT || '3741';

  log('SERVE', `Starting Rev4a on port ${port}…`);

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

  let shutdownSignal = null;
  let shuttingDown = false;
  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal = signal;
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

  // Watch for restart flag (written by rev4a update command)
  const RESTART_FLAG = join(DATA_DIR, '.restart-flag');
  const restartWatcher = setInterval(() => {
    if (existsSync(RESTART_FLAG)) {
      try { require('fs').unlinkSync(RESTART_FLAG); } catch {}
      cleanup('UPDATE');
    }
  }, 2000);
  restartWatcher.unref();

  // Wait for all children to exit, then restart if it was an update
  let exited = 0;
  for (const child of children) {
    child.on('exit', (code) => {
      exited++;
      log(child.spawnfile, `Exited (code ${code})`);
      if (exited >= children.length) {
        if (shutdownSignal === 'UPDATE') {
          // Poll until the port is actually free before restarting
          const net = require('net');
          const checkPort = () => {
            const tester = net.createServer();
            tester.once('error', () => {
              // Port still in use — retry
              setTimeout(checkPort, 500);
            });
            tester.once('listening', () => {
              tester.close(() => process.exit(42));
            });
            tester.listen(port, '0.0.0.0');
          };
          checkPort();
        } else {
          process.exit(0);
        }
      }
    });
  }

  // Print URL after a short delay (give Next.js time to bind)
  setTimeout(() => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        Rev4a is running            ║');
    console.log(`  ║        http://localhost:${String(port).padEnd(5)}     ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
  }, 2000);
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

const BANNER = `
  ████   █████  █   █  █   █   ███
  █   █  █      █   █  █   █  █   █
  ████   ████   █   █  █████  █████
  █  █   █       █ █       █  █   █
  █   █  █████    █        █  █   █
`;

const HELP_TEXT = `
USAGE:
  rev4a serve [--port <port>]   Start the dashboard + daemon + terminal WS
  rev4a build                   Build the Next.js app
  rev4a update                  Check for updates and install latest
  rev4a restart                 Signal a running rev4a to restart
  rev4a --help / --version      Show help or version

EXAMPLES:
  rev4a serve                    → http://localhost:3740
  rev4a serve --port 8080        → http://localhost:8080

On first run, rev4a serve automatically:
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

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(BANNER);
  console.log(`Rev4a v${pkg.version} — Agency Monitor Dashboard`);
  console.log(HELP_TEXT);
  process.exit(0);
}

if (cmd === 'serve') {
  console.log(BANNER);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : (parseInt(process.env.PORT, 10) || DEFAULT_PORT);

  // Kill any stale rev4a processes on this port before starting.
  // Prevents zombie process accumulation on systems without systemd.
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'pipe', timeout: 5000 });
  } catch { /* best-effort */ }

  // Auto-restart loop: when rev4a update triggers exit code 42,
  // re-exec rev4a serve so the new binary is loaded. Works with
  // or without systemd (systemd Restart=always also handles it).
  let exitCode = 42;
  while (exitCode === 42) {
    const result = spawnSync(
      process.execPath,
      [process.argv[1] || join(__dirname, 'rev4a.js'), '_run', String(port)],
      { stdio: 'inherit', env: process.env }
    );
    exitCode = result.signal ? 0 : (result.status ?? 0);
    if (exitCode === 42) {
      console.log('[REV4A] Restarting with updated binary…');
      // Wait for the port to be fully released before respawning
      const net = require('net');
      const portNum = port;
      try {
        const { execSync } = require('child_process');
        execSync('sleep 1', { stdio: 'ignore' });
      } catch {}
    }
  }
  process.exit(exitCode);
}

// Internal entry point: called by the auto-restart spawn above
if (cmd === '_run') {
  console.log(BANNER);
  const port = parseInt(args[args.indexOf('_run') + 1], 10) || DEFAULT_PORT;
  serve(port);
  return;
}

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(`rev4a v${pkg.version}`);
  process.exit(0);
}

if (cmd === 'build') {
  ensureEnv();
  build();
  process.exit(0);
}

if (cmd === 'restart') {
  // Find and kill the running rev4a serve process, then restart it.
  // Uses the restart flag file as the primary mechanism (works with
  // the watcher inside _run), but also does a direct kill + respawn
  // as a fallback for environments where the watcher might miss the flag
  // (e.g. multiple zombie processes, nohup edge cases).
  const RESTART_FLAG = join(DATA_DIR, '.restart-flag');
  writeFileSync(RESTART_FLAG, '');
  console.log('Restart signal sent. The running rev4a serve process will restart.');

  // Also kill the port directly — ensures restart even if watcher misses the flag
  const port = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'pipe', timeout: 5000 });
  } catch { /* best-effort */ }
  process.exit(0);
}

if (cmd === 'update') {
  console.log(`Checking for updates…`);
  try {
    const latest = execSync(
      `npm view ${PKG_NAME} version --registry https://registry.npmjs.org 2>/dev/null`,
      { stdio: 'pipe', timeout: 10_000 },
    ).toString().trim();
    if (latest === pkg.version) {
      console.log(`Already up to date (v${pkg.version}).`);
      process.exit(0);
    }
    console.log(`Updating from v${pkg.version} to v${latest}…`);
    const root = process.env.REV4A_ROOT || ROOT;
    const isGitRepo = existsSync(join(root, '.git'));
    if (isGitRepo) {
      console.log('Detected git repo — pulling and building…');
      execSync(`cd ${root} && git pull && npm install && npm run build`, {
        stdio: 'inherit',
        timeout: 120_000,
      });
    } else {
      console.log('Using npm global install…');
      execSync(`npm install -g ${PKG_NAME}@latest`, {
        stdio: 'inherit',
        timeout: 120_000,
      });
      // Wipe old build so rev4a serve rebuilds with the new version
      const nextDir = join(ROOT, '.next');
      if (existsSync(nextDir)) {
        try { execSync(`rm -rf "${nextDir}"`, { stdio: 'inherit' }); } catch {}
      }
    }
    console.log('Update complete. Restarting…');
    try {
      execSync('rev4a restart', { stdio: 'inherit', timeout: 10_000 });
    } catch {
      // rev4a serve not running — restart flag written, harmless
    }
  } catch (err) {
    console.error('Update failed:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
console.error('Run rev4a --help for usage.');
process.exit(1);
