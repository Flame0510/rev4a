'use strict';

const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { ASK_PATH, domainConfig, normalizeDomain } = require('./domain.js');
const { DEFAULT_CADDY_FILE, DEFAULT_CADDY_MAIN } = require('./domain-name.js');
const { hasCaddyImport, onDemandOptions, scanCaddyfile } = require('./caddyfile.js');
const { applyEnvEdits, parseEnvValues } = require('./env-file.js');
const { CaddyRollbackUnconfirmedError, applyCaddyfile, atomicWrite, caddyAvailable, caddyDependencies, readSnapshot, restoreFile } = require('./caddy.js');
const SETUP_OVERRIDES = new Set(['PORT', 'REV4A_CADDY_MAIN', 'REV4A_CADDY_FILE']);

function planCaddyfile(text, config) {
  const { domain, file, askUrl } = config;
  const newline = text.match(/\r\n|\n/)?.[0] ?? '\n';
  const { blocks, imports } = scanCaddyfile(text, { requireBlocks: true });
  const global = blocks.find(block => block.header.length === 0);
  const edits = [];
  const actions = [];
  const onDemand = ['\ton_demand_tls {', `\t\task ${askUrl}`, '\t}'].join(newline);
  if (!global) {
    edits.push({ start: 0, end: 0, text: ['{', onDemand, '}', '', ''].join(newline) });
    actions.push('Add the global on-demand TLS ask endpoint');
  } else {
    const options = onDemandOptions(text, global);
    if (!options) {
      edits.push({ start: global.open.end, end: global.open.end, text: newline + onDemand + newline });
      actions.push('Merge the on-demand TLS endpoint into the existing global options');
    } else {
      const { ask } = options;
      if (options.permission) throw new Error('Caddy already uses a global on-demand TLS permission module.');
      if (!ask) {
        edits.push({ start: options.start.end, end: options.start.end, text: newline + `\t\task ${askUrl}` + newline });
        actions.push('Add the ask endpoint to the existing on-demand TLS options');
      } else if (ask.value !== askUrl) {
        if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/domain\/ask$/.test(ask.value)) {
          throw new Error('Caddy already uses a different global on-demand TLS ask endpoint.');
        }
        edits.push({ start: ask.start, end: ask.end, text: askUrl });
        actions.push('Set the Rev4a ask endpoint to the current dashboard port');
      }
    }
  }

  const isDashboard = address => {
    const host = address.toLowerCase().replace(/,$/, '');
    return host === domain || host === `https://${domain}` || host === `${domain}:443` || host === `https://${domain}:443`;
  };
  for (const block of blocks) {
    if (!block.header.some(token => token.value.split(',').some(isDashboard))) continue;
    if (block.header.length !== 1 || !isDashboard(block.header[0].value) || block.header[0].value.endsWith(',')) {
      throw new Error('The dashboard hostname shares a Caddy site with other addresses. Move it to its own block before setup.');
    }
    const start = text.lastIndexOf('\n', block.header[0].start - 1) + 1;
    const eol = text.indexOf('\n', block.close.end);
    const end = eol === -1 ? text.length : eol;
    const original = text.slice(start, end);
    const trailing = text.slice(block.close.end, end);
    if (text.slice(start, block.header[0].start).trim() || (trailing.trim() && !trailing.trimStart().startsWith('#'))) {
      throw new Error('Put the existing dashboard site on its own lines before setup.');
    }
    edits.push({ start, end, text: `# Rev4a adopted ${domain}. Its previous site is preserved below.` + newline
      + original.replace(/^(?!\r?$)/gm, '# ') });
    actions.push(`Comment out and preserve the previous ${domain} site`);
  }

  // Apply source edits backwards. At offset zero the site edit precedes the global insertion.
  let content = text;
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of edits) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  if (!hasCaddyImport(imports, config)) {
    if (content && !content.endsWith('\n')) content += newline;
    content += `${newline}import ${file}${newline}`;
    actions.push(`Import ${file}`);
  }
  return { content, actions };
}

function planDomainEnvironment(text, domain, inherited) {
  const current = parseEnvValues(text);
  const proxies = (current.REV4A_TRUSTED_PROXIES || inherited.REV4A_TRUSTED_PROXIES || '')
    .split(',').map(entry => entry.trim()).filter(Boolean);
  const values = {
    REV4A_DOMAIN: domain,
    REV4A_LISTEN: 'local',
    REV4A_AGENT_PORTS_LISTEN: 'local',
    REV4A_TRUSTED_PROXIES: [...new Set([...proxies, '127.0.0.1', '::1'])].join(','),
  };
  return applyEnvEdits(text, Object.entries(values).filter(([key, value]) => current[key] !== value));
}

const REPO = 'https://dl.cloudsmith.io/public/caddy/stable';
async function installCaddy(io, run) {
  const apt = args => run('apt-get', args, { timeout: 300_000 });
  await apt(['update']);
  await apt(['install', '-y', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https', 'curl', 'gnupg']);
  const tempDir = await io.mkdtemp(join(tmpdir(), 'rev4a-caddy-'));
  const key = join(tempDir, 'caddy.asc');
  const keyring = join(tempDir, 'caddy.gpg');
  const sources = join(tempDir, 'caddy.list');
  try {
    await run('curl', ['-fsSL', '--proto', '=https', `${REPO}/gpg.key`, '-o', key]);
    await run('gpg', ['--batch', '--dearmor', '--output', keyring, key]);
    await run('curl', ['-fsSL', '--proto', '=https', `${REPO}/debian.deb.txt`, '-o', sources]);
    await atomicWrite(io, '/usr/share/keyrings/caddy-stable-archive-keyring.gpg', await io.readFile(keyring), 0o644);
    await atomicWrite(io, '/etc/apt/sources.list.d/caddy-stable.list', await io.readFile(sources), 0o644);
  } finally {
    for (const file of [key, keyring, sources]) await io.unlink(file).catch(() => {});
    await io.rmdir(tempDir);
  }
  await apt(['update']);
  await apt(['install', '-y', 'caddy']);
}

async function setupDomain({ args, dataDir, env = process.env, platform = process.platform, uid = process.getuid?.(), ...overrides }) {
  if (platform !== 'linux') throw new Error('rev4a domain setup requires Linux.');
  if (uid !== 0) throw new Error('rev4a domain setup requires root. Run it with sudo on the Rev4a host.');
  const [subcommand, value, ...flags] = args;
  if (subcommand !== 'setup' || !value || (flags.length && (flags.length !== 1 || flags[0] !== '--dry-run'))) {
    throw new Error('Usage: rev4a domain setup <domain> [--dry-run]');
  }
  const domain = normalizeDomain(value);
  if (!domain) throw new Error('A dashboard domain is required.');
  const log = overrides.log ?? console;
  const deps = caddyDependencies({ warn: message => log.warn(`[domain] ${message}`), ...overrides });
  const { io, run } = deps;
  const envFile = resolve(dataDir, '.env');

  async function plan() {
    const envBefore = await readSnapshot(io, envFile);
    const text = envBefore?.text ?? '';
    const saved = parseEnvValues(text);
    const settings = { ...env };
    for (const [key, val] of Object.entries(saved)) {
      if (SETUP_OVERRIDES.has(key) && settings[key]) continue;
      if (val || !settings[key]) settings[key] = val;
    }
    const config = domainConfig({ ...settings, REV4A_DOMAIN: domain });
    if ([envFile, resolve(dataDir, 'domain-auth.json')].some(file => file === config.main || file === config.file)) {
      throw new Error('Caddyfile paths must be separate from the Rev4a environment and credential files.');
    }
    const mainBefore = await readSnapshot(io, config.main);
    const environment = planDomainEnvironment(text, domain, env);
    // Keep the managed import discoverable after restart, including after an unconfirmed rollback
    // with paths passed only to the root setup process.
    const paths = [
      ['REV4A_CADDY_MAIN', config.main, DEFAULT_CADDY_MAIN],
      ['REV4A_CADDY_FILE', config.file, DEFAULT_CADDY_FILE],
    ].filter(([key, value, fallback]) => (saved[key] || fallback) !== value)
      .map(([key, value]) => [key, value]);
    const updatedPaths = applyEnvEdits(environment.content, paths);
    return { config, envBefore, mainBefore, main: planCaddyfile(mainBefore?.text ?? '', config),
      environment: { content: updatedPaths.content, updated: [...environment.updated, ...updatedPaths.updated] } };
  }

  const initial = await plan();
  const printRestart = () => log.info('Restart Rev4a and Recreate running agents to apply the local listen settings.');
  if (flags.length) {
    log.info('Install Caddy from its official apt repository if missing.');
    for (const action of initial.main.actions) log.info(action);
    if (initial.main.actions.length && initial.mainBefore) log.info(`Back up ${initial.config.main} before editing it.`);
    for (const key of initial.environment.updated) log.info(`Set ${key} in ${envFile}.`);
    log.info(`Sync ${initial.config.file} and validate ${initial.config.main} before any reload.`);
    printRestart();
    return { changed: false };
  }

  let installed = false;
  if (!await caddyAvailable(run)) {
    await installCaddy(io, run);
    log.info('Installed Caddy from its official apt repository.');
    installed = true;
  }
  return deps.withLock(initial.config.file, async () => {
    const { config, envBefore, mainBefore, main, environment } = await plan();
    if (config.file !== initial.config.file || config.main !== initial.config.main) {
      throw new Error('The Caddyfile paths changed during setup. Run setup again.');
    }
    const mainChanged = main.content !== (mainBefore?.text ?? '');
    const envChanged = environment.content !== (envBefore?.text ?? '') || envBefore?.mode !== 0o600;
    let backup;
    let wroteMain = false;
    let wroteEnv = false;
    const mainMode = mainBefore?.mode ?? 0o644;
    const editEnv = async operation => {
      // A custom import can share the environment directory, which is already locked.
      const [envParent, caddyParent] = await Promise.all(
        [dirname(envFile), dirname(config.file)].map(directory => io.realpath(directory)),
      );
      return envParent === caddyParent ? operation() : deps.withLock(envFile, operation, { io });
    };
    const restoreMain = async () => {
      if (!wroteMain) return true;
      const latest = await readSnapshot(io, config.main);
      if (latest?.text === main.content && latest.mode === mainMode
          && (!mainBefore || (latest.uid === mainBefore.uid && latest.gid === mainBefore.gid))) {
        await restoreFile(io, config.main, mainBefore);
        wroteMain = false;
        return true;
      }
      wroteMain = false;
      log.warn(`The main Caddyfile changed during setup. Kept the current ${config.main}.`);
      return false;
    };
    try {
      if (mainChanged) {
        if (mainBefore) {
          const now = (overrides.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
          backup = `${config.main}.bak-${now}`;
          await io.copyFile(config.main, backup, require('node:fs').constants.COPYFILE_EXCL);
        }
        await atomicWrite(io, config.main, main.content, mainMode, mainBefore);
        wroteMain = true;
      }
      if (envChanged && !envBefore) await io.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const result = await applyCaddyfile(config, dataDir, deps, {
        mainChanged,
        restoreMain,
        beforeReload: envChanged ? () => editEnv(async () => {
          const latest = await readSnapshot(io, envFile);
          if (latest?.text !== envBefore?.text || latest?.mode !== envBefore?.mode
              || latest?.uid !== envBefore?.uid || latest?.gid !== envBefore?.gid) {
            throw new Error('The Rev4a environment changed during setup. Run setup again to preserve the latest settings.');
          }
          await atomicWrite(io, envFile, environment.content, 0o600, envBefore);
          wroteEnv = true;
        }) : undefined,
      });
      if (backup) log.info(`Backed up ${config.main} to ${backup}.`);
      for (const action of main.actions) log.info(action);
      if (envChanged) log.info(`Updated the domain and local listen settings in ${envFile}.`);
      if (result.changed) log.info(`Validated and reloaded Caddy with ${result.routes} agent route(s) for ${domain}.`);
      const changed = installed || envChanged || result.changed;
      if (!changed) log.info(`Domain mode for ${domain} is already configured.`);
      else printRestart();
      return { changed };
    } catch (error) {
      if (error instanceof CaddyRollbackUnconfirmedError) {
        throw new Error(`${error.message} Domain settings were kept in ${envFile}. `
          + `To recover, run sudo caddy reload --config ${config.main} --adapter caddyfile. `
          + `To withdraw the managed routes, remove the import of ${config.file} from ${config.main} and reload Caddy.`, { cause: error });
      }
      const rollbacks = [];
      if (wroteMain) rollbacks.push(restoreMain());
      if (wroteEnv && environment.updated.length) rollbacks.push(editEnv(async () => {
        const latest = await readSnapshot(io, envFile);
        if (!latest) return;
        const current = parseEnvValues(latest.text);
        const setup = parseEnvValues(environment.content);
        const original = parseEnvValues(envBefore?.text ?? '');
        const edits = environment.updated.filter(key => current[key] === setup[key]).map(key => [key, original[key]]);
        if (!edits.length) return;
        const { content } = applyEnvEdits(latest.text, edits, { keepEmpty: true });
        await atomicWrite(io, envFile, content, 0o600, latest);
      }));
      const failures = (await Promise.allSettled(rollbacks)).filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(`${error.message} Setup rollback failed: ${failures.map(result => result.reason.message).join(', ')}`);
      throw error;
    }
  }, { io });
}

module.exports = { planCaddyfile, planDomainEnvironment, setupDomain };
