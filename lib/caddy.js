'use strict';

const fs = require('node:fs/promises');
const { dirname, join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { parseEnvValues } = require('./env-file.js');
const { withFileDirectoryLock } = require('./file-lock.js');
const { dockerRequestJson } = require('./docker-socket-path.js');
const { hasCaddyImport, onDemandOptions, scanCaddyfile } = require('./caddyfile.js');
const { BCRYPT, DEV_USER, emptyCaddyfile, agentBase, agentHostPort, buildNameTable, canRouteAgent, domainConfig, isGenerated,
  pendingCaddyfile, readAssignments, readRetiredLabels, renderCaddyfile } = require('./domain.js');

function runCommand(file, args, { input, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
      if (error) {
        if (input === undefined && stderr) error.message = `${file} ${args[0]}: ${stderr.trim()}`;
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin.on('error', () => {}); // The exit callback reports early command failures.
    child.stdin.end(input);
  });
}

async function readSnapshot(io, file) {
  let stat;
  try {
    stat = await io.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${file}.`);
  return { text: await io.readFile(file, 'utf8'), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
}

async function atomicWrite(io, file, text, mode, owner) {
  const temp = join(dirname(file), `.rev4a-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await io.open(temp, 'wx', mode);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      if (owner) await handle.chown(owner.uid, owner.gid);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(temp, file);
  } catch (error) {
    await io.unlink(temp).catch(() => {});
    throw error;
  }
}

async function restoreFile(io, file, previous) {
  if (previous) await atomicWrite(io, file, previous.text, previous.mode, previous);
  else await io.unlink(file);
}

async function caddyAvailable(run) {
  try {
    await run('caddy', ['version']);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function agentFromInspect(inspect) {
  const containerName = (inspect.Name || '').replace(/^\//, '');
  if (!/^[A-Za-z0-9][\w.-]*$/.test(containerName)) throw new Error('Docker returned an invalid agent container name.');
  return {
    id: inspect.Id,
    containerName,
    displayName: inspect.Config?.Env?.find(entry => entry.startsWith('AGENT_NAME='))?.slice('AGENT_NAME='.length),
    created: inspect.Created,
    running: canRouteAgent(inspect.State),
    activeBindings: inspect.NetworkSettings?.Ports,
  };
}

async function checkAgentRoute({ container, base, containerPort, hostPort }, dockerFetch = dockerRequestJson) {
  const inspect = await dockerFetch('GET', `/containers/${encodeURIComponent(container)}/json`, 2000, AbortSignal.timeout(2000));
  if (!inspect.Config?.Labels?.AGENT_ID) return false;
  const agent = agentFromInspect(inspect);
  return agent.containerName === container && agentBase(agent) === base
    && agentHostPort(agent, containerPort) === hostPort;
}

async function readAgents(dockerFetch) {
  const signal = AbortSignal.timeout(15_000);
  const filters = encodeURIComponent(JSON.stringify({ label: ['AGENT_ID'] }));
  const containers = await dockerFetch('GET', `/containers/json?all=true&filters=${filters}`, 5000, signal);
  if (!Array.isArray(containers)) throw new Error('Docker returned an invalid container list (expected an array).');
  const agents = [];
  // Bound concurrent Docker requests without letting a failed inspect silently remove a route.
  for (let start = 0; start < containers.length; start += 8) {
    const batch = await Promise.all(containers.slice(start, start + 8).map(async container => {
      const inspect = await dockerFetch('GET', `/containers/${encodeURIComponent(container.Id)}/json`, 5000, signal);
      return agentFromInspect(inspect);
    }));
    agents.push(...batch);
  }
  return agents;
}

function validCredential(snapshot) {
  if (snapshot?.mode !== 0o600) return null;
  let credential;
  try { credential = JSON.parse(snapshot.text); } catch { return null; }
  return credential?.user === DEV_USER && typeof credential.password === 'string'
    && /^[A-Za-z0-9_-]{32}$/.test(credential.password)
    && typeof credential.hash === 'string' && BCRYPT.test(credential.hash) ? credential : null;
}

async function readDomainCredential(dataDir, io = fs) {
  try {
    const credential = validCredential(await readSnapshot(io, join(dataDir, 'domain-auth.json')));
    return credential ? { user: credential.user, password: credential.password } : null;
  } catch {
    return null;
  }
}

async function devHash(dataDir, { io, run, warn }) {
  const file = join(dataDir, 'domain-auth.json');
  const previous = await readSnapshot(io, file);
  const credential = validCredential(previous);
  if (credential) return { hash: credential.hash, save: null };

  const password = randomBytes(24).toString('base64url');
  let hash;
  try {
    hash = await run('caddy', ['hash-password', '--algorithm', 'bcrypt'], { input: password });
  } catch {
    throw new Error('Caddy could not hash the dev port password.');
  }
  if (!BCRYPT.test(hash)) throw new Error('Caddy returned an invalid bcrypt hash.');
  // Persist the password before Caddy can serve the matching hash. A retry can reuse it if reload fails.
  const save = async () => {
    await atomicWrite(io, file, JSON.stringify({ user: DEV_USER, password, hash }) + '\n', 0o600, previous);
    if (previous) warn?.('Regenerated the invalid domain credential file with mode 0600.');
  };
  return { hash, save };
}

function caddyDependencies(overrides) {
  return { io: fs, run: runCommand, dockerFetch: dockerRequestJson, withLock: withFileDirectoryLock, ...overrides };
}

async function caddyMain(io, config) {
  const text = (await readSnapshot(io, config.main))?.text ?? '';
  const { blocks, imports } = scanCaddyfile(text);
  const options = onDemandOptions(text, blocks.find(block => block.header.length === 0));
  return { imports, askUrl: options?.ask?.value, permission: Boolean(options?.permission) };
}

async function verifyCaddyImport(io, config) {
  const { imports } = await caddyMain(io, config);
  if (!hasCaddyImport(imports, config)) {
    throw new Error(`${config.file} is not imported by ${config.main}. Run rev4a domain setup on the host.`);
  }
}

/** Caller holds the directory lock. Setup can include its main-file edit in the same validation. */
async function applyCaddyfile(config, dataDir, deps, { mainChanged = false, beforeReload, forgetContainer } = {}) {
  const { io, run, dockerFetch } = deps;
  const reserved = [resolve(dataDir, '.env'), resolve(dataDir, 'domain-auth.json')];
  if (reserved.includes(config.file) || reserved.includes(config.main)) throw new Error('Caddyfile paths must be separate from Rev4a data files.');
  const previous = await readSnapshot(io, config.file);
  if (previous && !isGenerated(previous.text)) throw new Error(`Refusing to replace an unmanaged file at ${config.file}.`);
  const agents = await readAgents(dockerFetch);
  const assignments = readAssignments(previous?.text, config.domain);
  const retired = readRetiredLabels(previous?.text, config.domain);
  if (forgetContainer) {
    const name = assignments.get(forgetContainer)?.name;
    if (name) retired.add(name);
    assignments.delete(forgetContainer);
  }
  const table = buildNameTable(agents, assignments, config.port, retired);
  const credential = table.routes.some(route => route.dev) ? await devHash(dataDir, deps) : undefined;
  const hash = credential?.hash;
  const next = renderCaddyfile(config, table, hash);
  const fileChanged = previous?.text !== next || previous?.mode !== 0o644;
  if (!fileChanged && !mainChanged && !beforeReload && !credential?.save) {
    await verifyCaddyImport(io, config);
    return { changed: false, routes: table.routes.length };
  }

  if (fileChanged) await atomicWrite(io, config.file, pendingCaddyfile(next, previous?.text), 0o644, previous);
  const args = ['--config', config.main, '--adapter', 'caddyfile'];
  let reloadTried = false;
  try {
    await run('caddy', ['validate', ...args]);
    await verifyCaddyImport(io, config);
    await beforeReload?.();
    await credential?.save?.();
    if (fileChanged || mainChanged) {
      reloadTried = true;
      await run('caddy', ['reload', ...args]);
    }
  } catch (error) {
    if (fileChanged) {
      try {
        // Never delete the file on a first sync: the main Caddyfile may already import it, and a missing
        // import target makes Caddy refuse its next load. An empty managed file is always a valid target.
        if (previous) await restoreFile(io, config.file, previous);
        else await atomicWrite(io, config.file, emptyCaddyfile(), 0o644, null);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${error.message} Could not restore ${config.file}: ${restoreError.message}`);
      }
      // A reload that timed out may still have applied the candidate: reload the restored file so Caddy
      // never keeps routes (and upstream ports) that the file on disk no longer reserves.
      if (reloadTried) await run('caddy', ['reload', ...args]).catch(reloadError => deps.warn?.(`Could not reload the restored Caddy file: ${reloadError.message}`));
    }
    throw error;
  }
  if (fileChanged) {
    // Leave the marker on a failed final write so the next sync retries the transaction.
    try {
      await atomicWrite(io, config.file, next, 0o644, previous);
    } catch (error) {
      deps.warn?.(`Could not clear the Caddy reload marker: ${error.message}`);
    }
  }
  return { changed: fileChanged || mainChanged, routes: table.routes.length };
}

async function readDomainSettings(env, dataDir, io) {
  const content = await io.readFile(join(dataDir, '.env'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const saved = parseEnvValues(content);
  const fromFile = new Set((env.REV4A_DOTENV_KEYS || '').split(','));
  const settings = { ...env };
  for (const key of ['REV4A_DOMAIN', 'REV4A_CADDY_FILE', 'REV4A_CADDY_MAIN',
    'REV4A_LISTEN', 'REV4A_TRUSTED_PROXIES', 'REV4A_AGENT_PORTS_LISTEN']) {
    if (saved[key] || fromFile.has(key)) settings[key] = saved[key] || undefined;
  }
  return { settings, saved };
}

async function awaitingRestart(config, env, dataDir, io) {
  const { settings, saved } = await readDomainSettings(env, dataDir, io);
  const next = domainConfig(settings);
  if (!next || ['domain', 'file', 'main'].some(key => next[key] !== config[key])) return true;

  // The CLI can set a custom port through its own environment without writing PORT to .env.
  const installedAsk = (await caddyMain(io, config)).askUrl;
  return installedAsk ? installedAsk !== config.askUrl
    : Boolean(saved.PORT && domainConfig({ ...settings, PORT: saved.PORT }).port !== config.port);
}

let lastError;
let restartPending = false;
async function syncCaddy({ env = process.env, dataDir, forgetContainer, ...overrides }) {
  if (!env.REV4A_DOMAIN?.trim()) return { ok: true, changed: false };
  const log = overrides.log ?? console;
  const deps = caddyDependencies({ warn: message => log.warn(`[domain] ${message}`), ...overrides });
  try {
    const config = domainConfig(env);
    if (!await caddyAvailable(deps.run)) throw new Error('Caddy is missing. Run rev4a domain setup on the host.');
    const result = await deps.withLock(config.file, async () => {
      if (await awaitingRestart(config, env, dataDir, deps.io)) {
        if (!restartPending) log.info('[domain] Saved Caddy settings differ from the running Rev4a configuration. Sync is paused until restart.');
        restartPending = true;
        return { changed: false };
      }
      restartPending = false;
      return applyCaddyfile(config, dataDir, deps, { forgetContainer });
    }, deps.io);
    lastError = undefined;
    if (result.changed) log.info(`[domain] Reloaded Caddy with ${result.routes} agent route(s) for ${config.domain}.`);
    return { ok: true, ...result };
  } catch (error) {
    if (lastError !== error.message) log.warn(`[domain] Caddy sync failed: ${error.message}`);
    lastError = error.message;
    return { ok: false, changed: false, error: error.message };
  }
}

module.exports = { applyCaddyfile, atomicWrite, caddyAvailable, caddyDependencies, caddyMain, checkAgentRoute,
  readDomainCredential, readDomainSettings, readSnapshot, restoreFile, syncCaddy };
