#!/usr/bin/env node
/**
 * Olympus CLI — Dashboard for monitoring OpenClaw agents
 *
 * Usage:
 *   olympus start [--port <port>]  Start Next.js server (auto-build)
 *   olympus daemon                  Start the session poller daemon
 *   olympus terminal-ws             Start the WebSocket PTY server
 *   olympus all [--port <port>]     Start all three processes (dev mode)
 *   olympus build                   Manual build
 *   olympus --help                  Show help
 */

const { spawn, execSync } = require('child_process');
const { existsSync } = require('fs');
const { join, dirname } = require('path');

const ROOT = join(__dirname, '..');
const NEXT_DIR = join(ROOT, '.next');
const PKG_JSON = join(ROOT, 'package.json');

let pkg;
try { pkg = require(PKG_JSON); } catch { pkg = { version: '0.0.0' }; }

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function spawnProcess(script, args, opts = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
    ...opts,
  });
  child.on('exit', (code) => {
    log(script, `Exited (code ${code})`);
  });
  return child;
}

function build() {
  log('BUILD', 'Building Olympus…');
  execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
  log('BUILD', 'Build complete.');
}

function start(port) {
  const p = parseInt(port, 10) || 3720;
  log('START', `Starting Olympus Next.js on port ${p}…`);
  const child = spawn('npx', ['next', 'start', '-p', String(p)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(p), NODE_ENV: 'production' },
  });
  child.on('exit', (code) => {
    log('START', `Server exited (code ${code})`);
    process.exit(code ?? 0);
  });
}

function startDaemon() {
  log('DAEMON', 'Starting session poller daemon…');
  const child = spawnProcess('daemon.js', []);
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

function startTerminalWs() {
  const port = process.env.TERMINAL_WS_PORT || '3741';
  log('WS', `Starting terminal WebSocket on port ${port}…`);
  const child = spawnProcess('terminal-ws-server.js', []);
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

const args = process.argv.slice(2);
const cmd = args[0] || 'start';

const HELP_TEXT = `
Olympus v${pkg.version} — Agency Monitor Dashboard

USAGE:
  olympus start [--port <port>]   Start Next.js server (builds if needed)
  olympus daemon                   Start the session poller daemon
  olympus terminal-ws              Start the WebSocket PTY server
  olympus all [--port <port>]      Start all three processes (for dev/testing)
  olympus build                    Build the Next.js app
  olympus --help                   Show this help

EXAMPLES:
  olympus start                    → http://localhost:3720
  olympus start --port 8080        → http://localhost:8080
  olympus all                      → Start dashboard + daemon + terminal WS

PRODUCTION:
  Use systemd for production deployments:
    sudo systemctl start olympus.target    (starts all three services)
    sudo systemctl enable olympus.target   (auto-start on boot)

  Or run setup.sh for a complete one-command install:
    curl -fsSL https://raw.githubusercontent.com/Flame0510/olympus/main/scripts/setup.sh | bash
`;

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (cmd === 'build') {
  if (existsSync(NEXT_DIR)) {
    log('BUILD', '.next already exists, skipping. Use --force to rebuild.');
    process.exit(0);
  }
  build();
  process.exit(0);
}

if (cmd === 'start') {
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || '3720';

  if (!existsSync(NEXT_DIR)) {
    log('START', 'No build found, running build first…');
    build();
  }

  start(port);
  process.exit(0);
}

if (cmd === 'daemon') {
  startDaemon();
  return; // keep event loop alive
}

if (cmd === 'terminal-ws') {
  startTerminalWs();
  return; // keep event loop alive
}

if (cmd === 'all') {
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || '3720';

  if (!existsSync(NEXT_DIR)) {
    log('BUILD', 'No build found, running build first…');
    build();
  }

  log('ALL', 'Starting all Olympus services…');
  const next = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
  });
  const daemon = spawn(process.execPath, ['daemon.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const ws = spawn(process.execPath, ['terminal-ws-server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', TERMINAL_WS_PORT: process.env.TERMINAL_WS_PORT || '3741' },
  });

  const cleanup = () => {
    for (const child of [next, daemon, ws]) {
      try { child.kill('SIGTERM'); } catch {}
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let exited = 0;
  for (const child of [next, daemon, ws]) {
    child.on('exit', () => {
      exited++;
      if (exited >= 3) process.exit(0);
    });
  }
  return; // keep event loop alive
}

console.error(`Unknown command: ${cmd}`);
console.error('Run olympus --help for usage.');
process.exit(1);
