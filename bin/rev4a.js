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
 *   3. Checks for Docker, installs it on eligible hosts, and waits for its daemon
 *   4. Ensures agent base image is built (builds if missing)
 *   5. Starts Next.js + daemon + terminal WS as a single process group
 *
 * rev4a serve auto-restarts when rev4a update triggers exit code 42.
 * No systemd required.
 *
 * Graceful shutdown on Ctrl+C / SIGTERM stops all children cleanly.
 */

const { spawn, execSync, execFileSync, spawnSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync, lstatSync, chmodSync, realpathSync, rmSync, openSync, closeSync, unlinkSync } = require('fs');
const { join, dirname, resolve } = require('path');
const { performance } = require('node:perf_hooks');
const crypto = require('crypto');
const { createServer } = require('net');
const os = require('os');
const { setTimeout: sleep } = require('timers/promises');
const { assertEnvValue, isLoaderEnvKey, disableLoaderEnvLines, removeRuntimeEnvLines, RUNTIME_ONLY_ENV_KEYS, parseEnvValues, applyEnvEdits } = require('../lib/env-file.js');
const {
  validPort, readProcessStartTime, readPidRecord, writePidRecord, removePidRecord,
  isRecordedProcess, describePortListeners, stopRev4aPids, waitForPort,
} = require('../lib/port-owner.js');
const { DOCKER_RUNTIME_PATHS, decideDockerInstall } = require('../lib/docker-install-policy.js');
const { seedGatewayKey } = require('../lib/gateway-key-seed.js');

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
const SERVER_PID_FILE = join(DATA_DIR, 'server.pid');
const RUN_PID_FILE = join(DATA_DIR, 'run.pid');
const RESTART_FLAG = join(DATA_DIR, '.restart-flag');
const RESTART_POLL_MS = 2000;
const ENV_SOURCE = join(CONFIG_DIR, '.env');
const ENV_LINK = join(ROOT, '.env');
const DOCKERFILE = join(ROOT, 'agent-templates', 'base-image', 'Dockerfile');
// Supported OpenClaw versions and image repositories, shared with the server.
const AGENT_VERSIONS = require(join(ROOT, 'lib', 'agent-versions.json'));
// The pinned-revision rule, shared with the server (lib/agent-versions.ts).
const IMAGE_REVISION = require(join(ROOT, 'lib', 'image-revision.js'));
// The phases of `rev4a update`, shown by the dashboard on every tab (lib/update-state.js).
const UPDATE_STATE = require(join(ROOT, 'lib', 'update-state.js'));
const DOCKER_NETWORK = 'rev4a-network';
// How long `serve` waits for the Docker daemon before starting without it. Like
// REV4A_DATA_DIR it is read from the real process environment (a systemd
// Environment= line, a shell export), because the .env file is loaded later.
const DOCKER_WAIT_SECONDS = (() => {
  const raw = (process.env.REV4A_DOCKER_WAIT_SECONDS || '').trim();
  if (!raw) return 90;
  const n = Number(raw);
  // 0 means a single check. Non-numeric or infinite values fall back to the
  // default, and the ceiling keeps a typo from holding start-up for hours.
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 600) : 90;
})();

// Fallback used only when package.json cannot be read — the published npm
// package name is the single source of truth, so never hardcode it elsewhere.
const FALLBACK_PKG_NAME = 'rev4a';

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
  return process.getuid?.() === 0;
}

function hasCmd(name) {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readDistro() {
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    const fields = {};
    for (const [, key, doubleQuoted, singleQuoted, unquoted] of release.matchAll(
      /^(ID|ID_LIKE)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9._-]+))[ \t]*\r?$/gm
    )) {
      fields[key] = doubleQuoted ?? singleQuoted ?? unquoted;
    }
    return { distroId: fields.ID, distroIdLike: fields.ID_LIKE };
  } catch {
    return {};
  }
}

// ── Docker auto-install and daemon wait ─────────────────────────────────────

/** Block this thread for `ms` without spawning a process (`sleep` is not on every OS). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait until the Docker daemon answers, up to DOCKER_WAIT_SECONDS.
 *
 * Finding the `docker` command only proves the CLI is installed. At boot the
 * daemon can still be starting — on the production host systemd started this
 * service a second before Docker. Start-up still worked, by accident: the first
 * `docker` call blocked on docker.socket until the daemon was up. With a daemon
 * slower than a later call's 10 s timeout, the image check would have concluded
 * the image was missing and tried to pull and rebuild it. Asking the daemon
 * directly, with a short per-attempt timeout, makes the wait explicit, bounded
 * and logged, whatever kind of Docker install this is.
 */
function waitForDockerDaemon() {
  const deadline = Date.now() + DOCKER_WAIT_SECONDS * 1000;
  let lastError = '';
  let announced = false;
  for (;;) {
    try {
      const version = execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'pipe', timeout: 10_000 })
        .toString().trim();
      if (version) {
        log('DOCKER', `Docker daemon ready (server ${version})`);
        return true;
      }
    } catch (err) {
      lastError = ((err.stderr && err.stderr.toString()) || err.message || '').trim().split('\n')[0];
    }
    if (Date.now() >= deadline) break;
    if (!announced) {
      log('DOCKER', `Waiting for the Docker daemon (up to ${DOCKER_WAIT_SECONDS}s)…`);
      announced = true;
    }
    sleepSync(2000);
  }
  log('DOCKER', `⚠ Docker daemon not reachable after ${DOCKER_WAIT_SECONDS}s: ${lastError || 'no answer'}`);
  log('DOCKER', '  Starting without it. Agents are unavailable and the startup sync reaches none; run Sync All Agents once Docker is up.');
  return false;
}

function canAutoInstallDocker(platform) {
  const decision = decideDockerInstall({
    platform,
    isRoot: isRoot(),
    ...(platform === 'linux' ? readDistro() : {}),
    env: process.env,
    existingPaths: DOCKER_RUNTIME_PATHS.filter((path) => existsSync(path)),
    podmanOnPath: hasCmd('podman'),
  });

  if (decision.action === 'install') return true;
  log('DOCKER', decision.reason);
  if (decision.action === 'guide') {
    const installUrl = platform === 'linux'
      ? 'https://docs.docker.com/engine/install/'
      : 'https://docs.docker.com/get-docker/';
    log('DOCKER', `  Install Docker manually: ${installUrl}`);
    log('DOCKER', '  Then run: rev4a serve');
  }
  return false;
}

function withDockerInstallLock(install) {
  const lockPath = '/run/rev4a-docker-install.lock';
  const guardDir = '/run/rev4a-docker-install';
  mkdirSync(guardDir, { recursive: true, mode: 0o700 });
  const guardFd = openSync(guardDir, 'r');
  try {
    // The directory inode stays in place so simultaneous launches cannot race
    // while removing a stale lock file and creating its replacement.
    const guard = spawnSync('flock', ['--exclusive', '--nonblock', '0'], {
      stdio: [guardFd, 'ignore', 'ignore'],
      timeout: 5000,
    });
    if (guard.error) throw guard.error;
    if (guard.status === 1) {
      log('DOCKER', 'Another Rev4a launch is handling Docker auto-install. Skipping this attempt.');
      return false;
    }
    if (guard.status !== 0) throw new Error('Could not lock the Docker auto-install directory');

    let lockFd;
    try {
      lockFd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const lock = lstatSync(lockPath);
      if (!lock.isFile()) throw new Error(`Docker auto-install lock is not a regular file: ${lockPath}`);
      if (Date.now() - lock.mtimeMs <= 15 * 60_000) {
        log('DOCKER', `Docker auto-install lock is still recent at ${lockPath}. Skipping this attempt.`);
        return false;
      }
      log('DOCKER', `Ignoring stale Docker auto-install lock at ${lockPath} (older than 15 minutes).`);
      unlinkSync(lockPath);
      lockFd = openSync(lockPath, 'wx', 0o600);
    }

    try {
      return install();
    } finally {
      try {
        unlinkSync(lockPath);
      } finally {
        closeSync(lockFd);
      }
    }
  } finally {
    closeSync(guardFd);
  }
}

/** True when the Docker daemon is reachable and the Docker-dependent steps can run. */
function ensureDocker() {
  if (hasCmd('docker')) {
    log('DOCKER', 'Docker CLI found');
    return waitForDockerDaemon();
  }

  const platform = os.platform();
  if (!canAutoInstallDocker(platform)) return false;

  let dockerAvailable;
  try {
    dockerAvailable = withDockerInstallLock(() => {
      if (hasCmd('docker')) {
        log('DOCKER', 'Docker CLI found');
        return true;
      }
      if (!canAutoInstallDocker(platform)) return false;

      log('DOCKER', 'Docker not found: installing it with the official script (get.docker.com). Set REV4A_DOCKER_AUTO_INSTALL=0 to skip.');

      const aptTimeout = 120_000;
      const installStarted = performance.now();
      execFileSync('apt-get', ['update', '-qq'], { stdio: 'inherit', timeout: aptTimeout });
      const aptRemainingMs = Math.floor(aptTimeout - (performance.now() - installStarted));
      if (aptRemainingMs <= 0) throw new Error('Docker prerequisite update timed out');
      execFileSync('apt-get', ['install', '-y', '-qq', 'curl', 'gnupg', 'lsb-release', 'ca-certificates'],
        { stdio: 'inherit', timeout: aptRemainingMs });

      if (hasCmd('docker')) {
        log('DOCKER', 'Docker CLI found');
        return true;
      }
      if (!canAutoInstallDocker(platform)) return false;

      const scriptTimeout = 180_000;
      const scriptRemainingMs = Math.min(scriptTimeout, Math.floor(aptTimeout + scriptTimeout - (performance.now() - installStarted)));
      if (scriptRemainingMs <= 0) throw new Error('Docker auto-install timed out');
      execSync('curl -fsSL https://get.docker.com | sh', { stdio: 'inherit', timeout: scriptRemainingMs });

      log('DOCKER', 'Docker installed successfully');
      return true;
    });
  } catch (err) {
    log('DOCKER', `⚠ Docker auto-install failed: ${err.message}`);
    log('DOCKER', '  Install manually:');
    log('DOCKER', '  https://docs.docker.com/engine/install/');
    log('DOCKER', '  Then run: rev4a serve');
    return false;
  }
  return dockerAvailable && waitForDockerDaemon();
}

// ── Agent image auto-pull ───────────────────────────────────────────────────

function ensureAgentImage() {
  if (!hasCmd('docker')) return; // Docker not available — skip, warn later

  // The newest OpenClaw version this release supports, kept under its version tag.
  // `:latest` is never used: an agent's version decides its data schema.
  const version = AGENT_VERSIONS.supported[0].version;
  const localRef = `${AGENT_VERSIONS.localRepository}:${version}`;
  const registry = (process.env.REV4A_AGENT_IMAGE_REGISTRY || '').trim() || AGENT_VERSIONS.registryRepository;
  // This path only runs when `<version>` is absent locally (the check above returns
  // otherwise), so it never replaces an existing image and needs no identity tag.
  // A pinned image revision is pulled by its immutable tag and recorded locally, like
  // pullAgentImage in lib/agent-images.ts (same rule: lib/image-revision.js).
  const pin = IMAGE_REVISION.pinnedRevision(AGENT_VERSIONS.supported[0]);
  const remoteRef = `${registry}:${IMAGE_REVISION.registryTag(version, pin)}`;

  try {
    const r = execFileSync('docker', ['image', 'inspect', localRef, '--format', '{{.Id}}'], { stdio: 'pipe', timeout: 10_000 });
    if (r.toString().trim()) {
      log('IMAGE', `Agent base image ${localRef} already exists`);
      return;
    }
  } catch {
    // Not downloaded yet
  }

  log('IMAGE', `Pulling agent base image ${remoteRef}…`);
  try {
    execFileSync('docker', ['pull', remoteRef], { stdio: 'inherit', timeout: 1_800_000 });
    if (pin) {
      execFileSync('docker', ['tag', remoteRef, IMAGE_REVISION.revisionRef(AGENT_VERSIONS.localRepository, version, pin)], { stdio: 'inherit', timeout: 10_000 });
    }
    execFileSync('docker', ['tag', remoteRef, localRef], { stdio: 'inherit', timeout: 10_000 });
    try {
      execFileSync('docker', ['rmi', remoteRef], { stdio: 'pipe', timeout: 30_000 }); // untag; the layers stay
    } catch { /* keeping the registry reference is harmless */ }
    log('IMAGE', `Agent base image pulled and tagged as ${localRef}`);
    return;
  } catch {
    log('IMAGE', '⚠ Pull from registry failed');
  }

  // A local build is only the same image when this Dockerfile builds that version.
  const dockerfileVersion = existsSync(DOCKERFILE)
    ? (/^ARG OPENCLAW_VERSION=(\S+)/m.exec(readFileSync(DOCKERFILE, 'utf-8')) || [])[1] || null
    : null;
  if (dockerfileVersion !== version) {
    log('IMAGE', `  The Dockerfile here builds ${dockerfileVersion || 'no version'}, not ${version}: no local build.`);
    log('IMAGE', '  Agent creation will be unavailable until the image is downloaded from the Agents page.');
    return;
  }

  log('IMAGE', `Building agent base image ${localRef} (this will take a few minutes)…`);
  log('IMAGE', '  → pulling node:24-bookworm-slim + installing OpenClaw + tooling');
  try {
    execFileSync(
      'docker', ['build', '--build-arg', `OPENCLAW_VERSION=${version}`, '-t', localRef, '-f', DOCKERFILE, join(DOCKERFILE, '..')],
      { stdio: 'inherit', timeout: 3_600_000 },
    );
    log('IMAGE', 'Agent base image built successfully');
  } catch {
    log('IMAGE', '⚠ Agent base image build failed. Agent creation will be unavailable.');
    log('IMAGE', `  Pull it manually: docker pull ${remoteRef} && docker tag ${remoteRef} ${localRef}`);
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

// ── Rev4a shared skills ──────────────────────────────────────────────────

/**
 * Deploy every skill under rev4a-skills/ (the package's own shared skills, e.g. rev4a-mongodb)
 * to the host's shared skills directory, when the text differs, so a Rev4a update with a new
 * skill text reaches agents that already use it. Mirrors ensureRev4aSkill() in
 * lib/rev4a-skills.ts (this file is CommonJS and cannot import lib/). Only the packaged
 * skills are written; any other skill in that directory is left alone. Never fatal.
 */
function ensureRev4aSkills() {
  const sourceRoot = join(ROOT, 'rev4a-skills');
  if (!existsSync(sourceRoot)) return;
  const targetRoot = join(CONFIG_DIR, 'shared', 'shared-skills');
  let names = [];
  try {
    names = readdirSync(sourceRoot).filter((n) => /^rev4a-[a-z0-9][a-z0-9-]{0,60}$/.test(n));
  } catch (err) {
    log('SKILLS', `⚠ Could not read rev4a-skills: ${err.message}`);
    return;
  }
  for (const name of names) {
    try {
      const source = join(sourceRoot, name, 'SKILL.md');
      if (!existsSync(source)) continue;
      const content = readFileSync(source, 'utf-8');
      const dir = join(targetRoot, name);
      const target = join(dir, 'SKILL.md');
      let deployed = '';
      try { deployed = existsSync(target) ? readFileSync(target, 'utf-8') : ''; } catch { /* written below */ }
      if (content === deployed) {
        log('SKILLS', `${name} up to date`);
        continue;
      }
      mkdirSync(dir, { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, content, 'utf-8');
      renameSync(tmp, target);
      log('SKILLS', `Deployed ${name} to ${dir}/`);
    } catch (err) {
      log('SKILLS', `⚠ Failed to deploy ${name}: ${err.message}`);
    }
  }
}

// ── .env setup ──────────────────────────────────────────────────────────────

const skippedEnvKeys = new Set();

function loadEnv() {
  const envFile = existsSync(ENV_SOURCE) ? ENV_SOURCE : null;
  if (!envFile) return {};

  const result = {};
  try {
    const content = readFileSync(envFile, 'utf-8');
    for (const [key, value] of Object.entries(parseEnvValues(content))) {
      if (key === 'REV4A_SETUP_CODE') continue;
      // Ignore loader controls even in an older .env already affected by injection.
      // Other operator-defined keys remain supported. Never log their values.
      if (isLoaderEnvKey(key)) {
        if (!skippedEnvKeys.has(key)) {
          skippedEnvKeys.add(key);
          log('ENV', `Warning: skipped unsafe environment key ${key}`);
        }
        continue;
      }
      result[key] = value;
    }
  } catch (err) {
    log('ENV', `Warning: failed to read ${envFile} — ${err.message}`);
  }
  return result;
}

// The environment serve() gives the dashboard (keep in step with the block in serve()): the Gateway
// key seeder resolves the data directory with it, before serve() builds the real one.
function loadServerEnv(port) {
  const envVars = loadEnv();
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envVars)) {
    // Preserve non-empty service values when the file assigns an empty value.
    if (value !== '' || !env[key]) env[key] = value;
  }
  // Record which non-empty values came from .env so runtime reads can detect edits.
  const dotenvKeys = Object.entries(envVars).filter(([key, value]) => value !== '' && !RUNTIME_ONLY_ENV_KEYS.includes(key)).map(([key]) => key);
  env.PORT = String(port);
  env.NODE_ENV = process.env.NODE_ENV || 'production';
  for (const key of RUNTIME_ONLY_ENV_KEYS) delete env[key];
  env.REV4A_DOTENV_KEYS = dotenvKeys.join(',');
  env.REV4A_SUPERVISED = '1';
  return env;
}

/**
 * The loader keys (NODE_OPTIONS, LD_*, DYLD_*...) Next.js would load from the .env files at
 * the package root, read by Next's own @next/env in a separate process (it writes what it
 * loads into its own process.env). Empty when @next/env cannot be run: the line repair and
 * server.js's strip remain the protection then.
 */
function loaderKeysNextWouldLoad() {
  const script = [
    'const { loadEnvConfig } = require(require.resolve("@next/env", { paths: [process.argv[1]] }));',
    'const r = loadEnvConfig(process.argv[1], false, { info() {}, error() {} }, true);',
    'process.stdout.write(JSON.stringify(Object.keys(r.parsedEnv || {})));',
  ].join('\n');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!isLoaderEnvKey(k)) env[k] = v;
  const result = spawnSync(process.execPath, ['-e', script, ROOT], { env, encoding: 'utf-8', timeout: 15_000 });
  if (result.status !== 0) {
    log('ENV', 'Warning: could not check .env with Next.js\'s loader; relying on the line repair');
    return [];
  }
  try {
    return [...new Set(JSON.parse(result.stdout).filter((key) => isLoaderEnvKey(key)))];
  } catch {
    return [];
  }
}

/** Stop before anything runs Next when its loader would still load a loader key (logged by name). */
function refuseIfLoaderKeysLeft() {
  const leftover = loaderKeysNextWouldLoad();
  if (leftover.length > 0) {
    log('ENV', `Refusing to start: a .env file at ${ROOT} or ${ENV_SOURCE} defines ${leftover.join(', ')} in a form Rev4a cannot disable automatically. Remove it by hand (set loader options in the service environment), then start Rev4a again.`);
    process.exit(1);
  }
}

function seedStartupGatewayKey(port) {
  const env = loadServerEnv(port);
  for (const key of Object.keys(env)) if (isLoaderEnvKey(key)) delete env[key];

  // Resolve Next's dotenv fallback and the OS home in the environment the dashboard sees.
  const script = String.raw`
    const { loadEnvConfig } = require(require.resolve('@next/env', { paths: [process.cwd()] }));
    const { readEnvValue } = require('./lib/env-file.js');
    const { homedir } = require('node:os');
    const { join } = require('node:path');
    const inherited = process.env.REV4A_DATA_DIR;
    const { loadedEnvFiles } = loadEnvConfig(process.cwd(), false, { info() {}, error() { process.exitCode = 1; } }, true);
    const source = loadedEnvFiles.find(({ env }) => Object.hasOwn(env, 'REV4A_DATA_DIR'));
    const configured = inherited ?? (source && readEnvValue(source.contents, 'REV4A_DATA_DIR'));
    // A path can reference server-only variables whose values are unavailable at this point.
    if (/\$\{?\w/.test(configured ?? '')) process.exit(1);
    const dataRoot = process.env.REV4A_DATA_DIR || (process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'rev4a')
      : join(homedir(), '.config', 'rev4a'));
    const { PROVIDER_DEEPSEEK_API_KEY, PROVIDER_OPENROUTER_API_KEY } = process.env;
    process.stdout.write(JSON.stringify({ dataRoot, PROVIDER_DEEPSEEK_API_KEY, PROVIDER_OPENROUTER_API_KEY }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 5000 });
  let resolved;
  if (!result.error && result.status === 0) {
    try { resolved = JSON.parse(result.stdout); } catch { /* handled below */ }
  }
  if (typeof resolved?.dataRoot !== 'string' || !resolved.dataRoot || resolved.dataRoot.includes('\0')
      || [resolved.PROVIDER_DEEPSEEK_API_KEY, resolved.PROVIDER_OPENROUTER_API_KEY].some((value) => value !== undefined && typeof value !== 'string')) {
    log('ENV', 'Warning: could not resolve the data directory; Gateway key not generated');
    return;
  }

  seedGatewayKey(resolve(ROOT, resolved.dataRoot, 'data', 'provider-keys.json'), resolved, (message) => log('ENV', message));
}

function ensureEnv({ startupPort } = {}) {
  let configured = false;
  try {
    readFileSync(ENV_SOURCE, 'utf-8');
    configured = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (configured) {
    // Best effort: a .env owned by another user (created with sudo) cannot be chmod-ed by
    // the service; warn and start rather than crash-loop after the update.
    try {
      if ((statSync(ENV_SOURCE).mode & 0o777) & ~0o600) {
        chmodSync(ENV_SOURCE, 0o600);
        log('ENV', 'Tightened .env permissions to 0600');
      }
    } catch (err) {
      log('ENV', `Warning: could not tighten .env permissions to 0600 (${err.code || err.message}); check its owner`);
    }
    log('ENV', 'Configuration found');
    // Before anything runs Next (the build in preflight loads .env on its own).
    const current = readFileSync(ENV_SOURCE, 'utf-8');
    const repaired = disableLoaderEnvLines(current);
    const runtimeRepair = removeRuntimeEnvLines(repaired.content);
    // Repair installs that completed setup before empty generated secrets counted as missing.
    // Only explicit empties in an editable file are repaired; never rotate a service secret.
    const values = parseEnvValues(runtimeRepair.content);
    let repairedSecrets = [];
    if (values.REV4A_PASSWORD || process.env.REV4A_PASSWORD) {
      const emptySecrets = ['REV4A_JWT_SECRET', 'REV4A_TOKEN']
        .filter((key) => values[key] === '' && !process.env[key]);
      if (emptySecrets.length > 0) {
        try {
          const edits = emptySecrets.map((key) => [key, randomString(key === 'REV4A_JWT_SECRET' ? 64 : 32)]);
          const result = applyEnvEdits(runtimeRepair.content, edits);
          runtimeRepair.content = result.content;
          repairedSecrets = result.updated;
        } catch (err) {
          log('ENV', `Warning: empty .env secrets were not repaired (${err.code || 'invalid file'}); edit the file by hand`);
        }
      }
    }
    if (runtimeRepair.content !== current) {
      try {
        // Write a sibling file, then rename: a failed or partial write (disk full) leaves the
        // original .env intact. The rename targets the real path, so a symlinked .env stays a link.
        // The file was just read, so its real path must resolve: if it does not, write nothing
        // (renaming over a link would replace the link and leave its target unrepaired).
        const target = realpathSync(ENV_SOURCE);
        const tmp = `${target}.tmp-${process.pid}`;
        // 'wx': create the temp file only if nothing is there (never follow or truncate an
        // existing path), and remove it only when this attempt created it.
        let created = false;
        try {
          const fd = openSync(tmp, 'wx', 0o600);
          created = true; // from here a partial write (disk full) is cleaned up below
          try { writeFileSync(fd, runtimeRepair.content, 'utf-8'); } finally { closeSync(fd); }
          try { chmodSync(tmp, 0o600); } catch { /* owner differs: warned above */ }
          renameSync(tmp, target);
          created = false;
        } catch (err) {
          if (created) { try { rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ } }
          throw err;
        }
        if (repairedSecrets.length > 0) log('ENV', `Filled empty .env secret(s): ${repairedSecrets.join(', ')}`);
      } catch (err) {
        // A loader key that could not be commented out is caught by refuseIfLoaderKeysLeft below.
        log('ENV', `Warning: could not write the .env repair (${err.code || err.message})`);
      }
    }
    if (repaired.disabled.length > 0) {
      log('ENV', `Disabled unsafe .env key(s): ${[...new Set(repaired.disabled)].join(', ')} (set loader options in the service environment instead)`);
    }
    if (runtimeRepair.removed.length > 0) {
      log('ENV', `Removed runtime-only .env key(s): ${[...new Set(runtimeRepair.removed)].join(', ')}`);
    }
    if (runtimeRepair.skipped) {
      log('ENV', '.env has a multi-line or unusual value: runtime-only keys were not cleaned automatically');
    }
    // Ensure symlink so the app can find .env at the root
    if (!existsSync(ENV_LINK)) {
      try { require('fs').symlinkSync(ENV_SOURCE, ENV_LINK); } catch {}
    }
    // The line repair above cannot follow every form Next's dotenv accepts (a key and its
    // '=' on different lines, ...). Ask Next's own loader what it would load, and refuse to
    // start rather than let a loader setting from .env reach the build or the server.
    refuseIfLoaderKeysLeft();
    // Seed agent token file if missing
    seedAgentToken();
    if (startupPort !== undefined) seedStartupGatewayKey(startupPort);
    return;
  }

  log('ENV', 'Generating default configuration…');

  mkdirSync(CONFIG_DIR, { recursive: true });

  const jwt = randomString(48);
  const token = randomString(32);
  const apiKey = 'rev_' + randomString(48);
  const gatewayToken = randomString(48);
  for (const [key, value] of Object.entries({
    REV4A_PASSWORD: '', REV4A_JWT_SECRET: jwt, REV4A_TOKEN: token,
    REV4A_API_KEY: apiKey, GATEWAY_TOKEN: gatewayToken,
  })) assertEnvValue(key, value);

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
  chmodSync(ENV_SOURCE, 0o600);
  log('ENV', `Written ${ENV_SOURCE}`);

  // Symlink in package root so Next.js server finds it
  try { require('fs').symlinkSync(ENV_SOURCE, ENV_LINK); } catch {}
  // A fresh .env holds none, but .env.local / .env.production at the package root may.
  refuseIfLoaderKeysLeft();

  seedAgentToken();
  if (startupPort !== undefined) seedStartupGatewayKey(startupPort);
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
    // Generous on purpose: a build is the slowest step of an install, and killing it
    // because it passed two minutes takes the server down over slowness alone.
    execSync('npx next build', { stdio: 'inherit', cwd: ROOT, timeout: 30 * 60_000 });
    if (!existsSync(join(NEXT_DIR, 'BUILD_ID'))) throw new Error('next build returned without a BUILD_ID');
    log('BUILD', 'Build complete');
  } catch (err) {
    log('BUILD', `Build failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Version check ───────────────────────────────────────────────────────────

/** Keep paths and configuration out of shell syntax, with one deadline for the update. */
function updateGitCheckout(root) {
  const deadline = Date.now() + 30 * 60_000;
  for (const [command, args] of [['git', ['pull']], ['npm', ['install']], ['npm', ['run', 'build']]]) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('Git update timed out');
    execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout });
  }
}

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

function preflight(port) {
  log('PREFLIGHT', 'Running pre-flight checks…');
  ensureEnv({ startupPort: port });
  // Network and image need the daemon. Without it the image check fails and
  // would start a pull and then a local build — up to fifteen minutes, before the
  // dashboard is even up — for an image that is most likely already there.
  if (ensureDocker()) {
    ensureNetwork();
    ensureAgentImage();
  } else {
    log('PREFLIGHT', 'Skipping network and agent image checks: Docker daemon not reachable.');
  }
  ensureRev4aRules();
  ensureRev4aSkills();

  if (!existsSync(join(NEXT_DIR, 'BUILD_ID'))) {
    log('PREFLIGHT', 'No complete build found — running build first…');
    build();
  }
}

// ── Serve (start all 3 processes) ───────────────────────────────────────────

const portReaders = {
  platform: process.platform,
  execFileSync: (file, args) => execFileSync(file, args, {
    encoding: 'utf8', stdio: 'pipe', timeout: 1500, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }),
  readFileSync: (file) => readFileSync(file, 'utf8'),
};
const pidFiles = { readFileSync: portReaders.readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync };
const portPoll = { now: () => performance.now(), sleep };
// Only records owned by this user are trusted (lstat: a symlink is never followed).
const pidOwner = typeof process.getuid === 'function' ? { lstatSync, uid: process.getuid() } : null;

function recordDashboardProcess(file, pid, port) {
  try {
    const startTime = readProcessStartTime(pid, portReaders);
    if (!startTime) throw new Error('Process start time unavailable');
    const record = { pid, port, startTime, root: ROOT };
    writePidRecord(file, record, pidFiles);
    return () => {
      try {
        removePidRecord(file, record, pidFiles);
      } catch (error) {
        log('SERVE', `Could not remove ${file}: ${error.message}`);
      }
    };
  } catch (error) {
    log('SERVE', `Could not write ${file}: ${error.message}`);
    return () => {};
  }
}

function recordDashboardProcesses(server, port) {
  process.once('exit', recordDashboardProcess(RUN_PID_FILE, process.pid, port));
  server.once('exit', recordDashboardProcess(SERVER_PID_FILE, server.pid, port));
}

function watchForRestart(onRestart) {
  const watcher = setInterval(() => {
    if (existsSync(RESTART_FLAG)) {
      try { unlinkSync(RESTART_FLAG); } catch {}
      onRestart();
    }
  }, RESTART_POLL_MS);
  watcher.unref();
}

function stopDashboardProcesses(records, tag) {
  return stopRev4aPids(records, portReaders, {
    ...portPoll,
    selfPid: process.pid,
    kill: process.kill,
    onSignal: (pid, signal) => log(tag, `Sent ${signal} to Rev4a process (PID ${pid})`),
    onError: (pid, signal, error) => log(tag, `Could not send ${signal} to Rev4a process (PID ${pid}): ${error.message}`),
  });
}

function probeDashboardPort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer((socket) => socket.destroy());
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, () => probe.close((error) => {
      if (error) reject(error);
      else resolve(true);
    }));
  });
}

async function prepareDashboardPort(port) {
  const probe = () => probeDashboardPort(port);
  try {
    if (await probe()) return true;
    const records = [RUN_PID_FILE, SERVER_PID_FILE]
      .map((file) => readPidRecord(file, pidFiles.readFileSync, pidOwner))
      .filter((record) => record?.port === port);
    const signaled = await stopDashboardProcesses(records, 'SERVE');
    if (signaled && await waitForPort(probe, portPoll)) return true;
    console.error(signaled
      ? `Port ${port} is still in use after stopping recorded Rev4a processes.`
      : `Port ${port} is already in use by another program.`);
    const listeners = describePortListeners(port, portReaders);
    if (listeners) console.error(listeners);
    console.error('Choose another dashboard port with PORT=<n> rev4a serve or rev4a serve --port <n>.');
  } catch (error) {
    console.error(`Could not bind dashboard port ${port}: ${error.message}`);
  }
  return false;
}

function serve(port, { recordProcesses, watchForRestart } = {}) {
  preflight(port);
  // Version check is non-blocking — runs after startup
  setTimeout(checkVersion, 2000);

  // Load .env vars so child processes (especially Next.js) can read REV4A_*
  // at runtime. process.env may not have them if rev4a serve was started
  // without the vars already exported in the shell.
  const envVars = loadEnv();
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(envVars)) {
    // Empty file assignments mean unset: preserve any non-empty service value.
    // Non-empty file values retain their precedence, including for secrets.
    if (value !== '' || !childEnv[key]) childEnv[key] = value;
  }
  // Names (never values) of the keys whose value came from .env: a setting read per create/Recreate
  // (REV4A_AGENT_PORTS_LISTEN) must not fall back to a stale copy once its .env entry is cleared.
  const dotenvKeys = Object.entries(envVars).filter(([key, value]) => value !== '' && !RUNTIME_ONLY_ENV_KEYS.includes(key)).map(([key]) => key);
  childEnv.PORT = String(port);
  childEnv.NODE_ENV = process.env.NODE_ENV || 'production';
  // A service EnvironmentFile may have exported stale state before the file repair ran.
  // Clear it from both sources before supplying this boot's credentials to specific children.
  for (const key of RUNTIME_ONLY_ENV_KEYS) delete childEnv[key];
  childEnv.REV4A_DOTENV_KEYS = dotenvKeys.join(',');
  childEnv.REV4A_SUPERVISED = '1';

  let setupCode;
  if (!childEnv.REV4A_PASSWORD) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(16), (byte) => alphabet[byte & 31]).join('');
    setupCode = code.match(/.{4}/g).join('-');
    log('SETUP', `${setupCode} — open the dashboard and enter this code`);
  }

  const children = [];
  const wsPort = process.env.TERMINAL_WS_PORT || '3741';
  // Shared by server.js (which forwards the terminal WebSocket after checking the session)
  // and the terminal server (which refuses anything without it). New at every start.
  const terminalSecret = require('crypto').randomBytes(32).toString('hex');

  log('SERVE', `Starting Rev4a on port ${port}…`);

  // Next.js, through server.js: the same pages and API, plus the terminal WebSocket on
  // this port (so the terminal needs no reverse proxy in front).
  const next = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...childEnv, ...(setupCode ? { REV4A_SETUP_CODE: setupCode } : {}),
      TERMINAL_WS_PORT: wsPort, REV4A_TERMINAL_SECRET: terminalSecret },
  });
  recordProcesses?.(next, port);
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
    env: { ...childEnv, TERMINAL_WS_PORT: wsPort, REV4A_TERMINAL_SECRET: terminalSecret },
  });
  children.push(ws);
  log('SERVE', `Terminal WS PID ${ws.pid}`);

  let shutdownSignal = null;
  let shuttingDown = false;
  let forceStop;
  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownSignal = signal;
    log('SERVE', `${signal} — stopping all services…`);
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch {}
    }
    // Force kill after 8s if any child survives
    forceStop = setTimeout(() => {
      for (const child of children) {
        try { child.kill('SIGKILL'); } catch {}
      }
      process.exit(shutdownSignal === 'UPDATE' ? 42 : 0);
    }, 8000);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  watchForRestart?.(() => cleanup('UPDATE'));

  // Wait for all children to exit, then restart if it was an update
  let exited = 0;
  for (const child of children) {
    child.on('exit', (code) => {
      exited++;
      log(child.spawnfile, `Exited (code ${code})`);
      if (exited >= children.length) {
        clearTimeout(forceStop);
        if (shutdownSignal === 'UPDATE') {
          // The supervisor probes again and reports any remaining conflict.
          waitForPort(() => probeDashboardPort(port), portPoll)
            .catch((error) => log('SERVE', `Could not bind dashboard port ${port}: ${error.message}`))
            .finally(() => process.exit(42));
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
  rev4a domain setup <domain> [--dry-run]  Configure Caddy on Linux (root)
  rev4a --help / --version      Show help or version

EXAMPLES:
  rev4a serve                    → http://localhost:3740
  rev4a serve --port 8080        → http://localhost:8080

On first run, rev4a serve automatically:
  • Generates .env (JWT secret + API token)
  • Downloads the agent base image for the newest supported OpenClaw version
  • Builds the Next.js app if no build is found
  • Starts Next.js, daemon, and terminal WebSocket as a single process group
  • Cleanly stops all services on Ctrl+C / SIGTERM

CONFIGURATION:
  Application settings live in .env (auto-generated on first run).
  Set your admin password via the web setup wizard at first visit.

DOCKER AT STARTUP:
  Rev4a installs Docker only when run as root on Debian, Ubuntu, or a derivative
  and it finds neither Docker nor Podman.
  Set REV4A_DOCKER_AUTO_INSTALL=0 in the process environment (systemd Environment=)
  to skip auto-install. Rev4a reads this setting before loading .env.
`;

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(BANNER);
  console.log(`Rev4a v${pkg.version} — Revolution for Agents`);
  console.log(HELP_TEXT);
  process.exit(0);
}

async function supervise(port) {
  // Auto-restart loop: when rev4a update triggers exit code 42,
  // re-exec rev4a serve so the new binary is loaded. Works with
  // or without systemd (systemd Restart=always also handles it).
  let exitCode = 42;
  while (exitCode === 42) {
    if (!await prepareDashboardPort(port)) return 1;
    const result = spawnSync(
      process.execPath,
      [process.argv[1] || join(__dirname, 'rev4a.js'), '_run', String(port)],
      { stdio: 'inherit', env: process.env }
    );
    exitCode = result.signal ? 0 : (result.status ?? 0);
    if (exitCode === 42) {
      console.log('[REV4A] Restarting…');
      await sleep(1000);
    }
  }
  return exitCode;
}

if (cmd === 'serve') {
  console.log(BANNER);
  const portIdx = args.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  const source = portIdx >= 0 ? '--port' : 'PORT';
  const rawPort = portIdx < 0 ? process.env.PORT ?? String(DEFAULT_PORT)
    : args[portIdx] === '--port' ? args[portIdx + 1] : args[portIdx].slice('--port='.length);
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!validPort(port)) {
    console.error(`Invalid dashboard port in ${source}. Use an integer between 1 and 65535.`);
    process.exitCode = 1;
    return;
  }
  supervise(port).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Could not start Rev4a: ${error.message}`);
    process.exitCode = 1;
  });
  return;
}

// Internal entry point: called by the auto-restart spawn above
if (cmd === '_run') {
  console.log(BANNER);
  const port = Number(args[1]);
  if (!validPort(port)) {
    console.error('Invalid dashboard port. Use an integer between 1 and 65535.');
    process.exitCode = 1;
    return;
  }
  serve(port, { recordProcesses: recordDashboardProcesses, watchForRestart });
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

if (cmd === 'domain') {
  const { setupDomain } = require('../lib/caddy-setup.js');
  setupDomain({ args: args.slice(1), dataDir: CONFIG_DIR }).catch((error) => {
    console.error(`Domain setup failed: ${error.message}`);
    process.exitCode = 1;
  });
  return;
}

if (cmd === 'build') {
  ensureEnv();
  build();
  process.exit(0);
}

if (cmd === 'restart') {
  // Snapshot the server before the watcher can replace it, including on a custom port.
  const server = readPidRecord(SERVER_PID_FILE, pidFiles.readFileSync, pidOwner);
  writeFileSync(RESTART_FLAG, '');
  console.log('Restart signal sent. The running rev4a serve process will restart.');

  // Give _run's watcher time to act. The fallback stops only its recorded server,
  // so _run can still consume the flag and request a relaunch of all services.
  if (isRecordedProcess(server, portReaders)) {
    sleep(RESTART_POLL_MS + 200)
      .then(() => stopDashboardProcesses([server], 'RESTART'))
      .catch((error) => {
        console.error(`Could not stop the recorded Rev4a server: ${error.message}`);
        process.exitCode = 1;
      });
  }
  return;
}

if (cmd === 'update') {
  const inheritedClaim = process.env[UPDATE_STATE.CLAIM_ENV] || '';
  // The version npm announces. It is the one installed below (not @latest), so a release
  // published in between cannot make a correct update read as "restarted on X+1, not X".
  const fetchLatest = () => {
    const out = execSync(
      `npm view ${PKG_NAME} version --registry https://registry.npmjs.org 2>/dev/null`,
      { stdio: 'pipe', timeout: 10_000 },
    ).toString().trim();
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(out)) {
      throw new Error(`npm returned an unexpected version: "${out.slice(0, 40)}"`);
    }
    return out;
  };
  // The server that answers right now, when the dashboard started this update. If the
  // installed version differs, an earlier update installed it but the restart never happened.
  const runningVersion = process.env.REV4A_RUNNING_VERSION || '';
  const installedNotRunning = Boolean(runningVersion) && runningVersion !== pkg.version;
  let latest = '';
  if (!inheritedClaim) {
    // From a shell: look first and claim only when there is something to do, so a no-op
    // update (or an unreachable registry) never shows the updating screen on the dashboard.
    console.log('Checking for updates…');
    try {
      latest = fetchLatest();
    } catch (err) {
      console.error('Could not check for updates:', err.message);
      process.exit(1);
    }
    if (latest === pkg.version) {
      console.log(`Already up to date (v${pkg.version}).`);
      process.exit(0);
    }
  }
  // One update at a time. The dashboard hands us its claim, so its own run is not a
  // competitor; anything else in progress (another terminal, the dashboard) is refused.
  // Written for the dashboard too; a state that cannot be written never stops the update.
  const claimed = UPDATE_STATE.claimUpdate(DATA_DIR, {
    from: pkg.version,
    claim: inheritedClaim || `cli-${process.pid}-${Date.now()}`,
    inherited: Boolean(inheritedClaim),
  });
  if (!claimed.ok) {
    console.error('Another update is already in progress. Wait for it to finish, then run rev4a update again.');
    process.exit(1);
  }
  const requestRestart = (target, from) => {
    // Written before the restart is requested: the server that starts after this write is
    // the new one, and marks the update done when it answers.
    UPDATE_STATE.writeUpdate(DATA_DIR, 'restarting', from ? { from, to: target } : { to: target });
    try {
      execSync('rev4a restart', { stdio: 'inherit', timeout: 10_000 });
    } catch {
      // rev4a serve not running — restart flag written, harmless
    }
  };
  if (inheritedClaim) console.log('Checking for updates…');
  try {
    if (!latest) latest = fetchLatest();
    if (latest === pkg.version) {
      if (installedNotRunning) {
        // An earlier update installed this version but the restart never happened.
        console.log(`v${pkg.version} is installed but Rev4a still runs v${runningVersion}. Restarting…`);
        // from = the running version: the screen reloads only when the version moves.
        requestRestart(pkg.version, runningVersion);
        process.exit(0);
      }
      console.log(`Already up to date (v${pkg.version}).`);
      UPDATE_STATE.clearUpdate(DATA_DIR);
      process.exit(0);
    }
    console.log(`Updating from v${pkg.version} to v${latest}…`);
    UPDATE_STATE.writeUpdate(DATA_DIR, 'installing', { from: pkg.version, to: latest });
    const root = process.env.REV4A_ROOT || ROOT;
    const isGitRepo = existsSync(join(root, '.git'));
    // The version the restarted server must run. A git checkout may pull something other
    // than npm's latest, so it is read back from the pulled package.json below.
    let target = latest;
    if (isGitRepo) {
      console.log('Detected git repo — pulling and building…');
      UPDATE_STATE.writeUpdate(DATA_DIR, 'building');
      updateGitCheckout(root);
      try { target = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || latest; } catch { /* keep latest */ }
    } else {
      console.log('Using npm global install…');
      execFileSync('npm', ['install', '-g', `${PKG_NAME}@${latest}`], {
        stdio: 'inherit',
        timeout: 20 * 60_000,
      });
      // postinstall builds the freshly installed package and fails the install if it
      // cannot; keep that build for the restart. The fallback covers a skipped build.
      if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
        UPDATE_STATE.writeUpdate(DATA_DIR, 'building');
        build();
      }
    }
    console.log('Update complete. Restarting…');
    requestRestart(target);
  } catch (err) {
    console.error('Update failed:', err.message);
    UPDATE_STATE.writeUpdate(DATA_DIR, 'failed', { error: err.message });
    process.exit(1);
  }
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
console.error('Run rev4a --help for usage.');
process.exit(1);
