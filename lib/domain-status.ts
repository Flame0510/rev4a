import { resolve } from 'node:path';
import { currentAgentPortsListen } from './agent-ports-server';
import { caddyAvailable, caddyDependencies, caddyMain, readDomainSettings, readSnapshot } from './caddy';
import { hasCaddyImport, scanCaddyfile } from './caddyfile';
import { ASK_PATH, domainConfig, isGenerated, parsePort, readManagedRoutes, type DomainEnv } from './domain';
import { DEFAULT_CADDY_FILE, DEFAULT_CADDY_MAIN } from './domain-name';
import { serverAddresses, serverNetworkInterfaces, type ServerAddresses } from './domain-status-addresses';
import { hostAddressList, listenAddresses } from './listen-addresses';
import { accessRestartPending } from './remote-access';

type ListenMode = ReturnType<typeof listenAddresses>['mode'];

interface SetupSettings {
  port: number;
  caddyMain: string;
  caddyFile: string;
}

export interface DomainStatus extends SetupSettings {
  domain: string | null;
  enabled: boolean;
  dataDir: string;
  savedSetup?: SetupSettings;
  caddy: {
    installed: boolean;
    managedFile: 'ok' | 'missing' | 'pending' | 'unmanaged' | 'incomplete';
    imported: boolean;
    onDemandAsk: boolean;
    askTarget: 'ok' | 'missing' | 'stale' | 'invalid';
  };
  listen: { panel: ListenMode; agents: ListenMode | 'keep' };
  routes: number;
  restartPending: boolean;
  serverAddresses: ServerAddresses;
}

function safeConfig(env: DomainEnv) {
  try { return domainConfig(env); } catch { return null; }
}

function panelListen(env: DomainEnv, hostAddresses: string[]): { mode: ListenMode; addresses: string[] } {
  try {
    const { mode, addresses } = JSON.parse(env.REV4A_LISTEN_STATE || '');
    if (mode === 'all' || mode === 'local' || mode === 'address') {
      return { mode, addresses: Array.isArray(addresses) ? addresses.filter((item) => typeof item === 'string') : [] };
    }
  } catch { /* Without a supervised listener, fall back to the setting. */ }
  return listenAddresses(env.REV4A_LISTEN, { hostAddresses });
}

function hasManagedSites(text: string, domain: string): boolean {
  try {
    const { blocks } = scanCaddyfile(text, { requireBlocks: true });
    const hasSite = (host: string, directive: string) => blocks.some(({ header, body }) =>
      header.length === 1 && header[0].value === host && body[0]?.value === directive);
    return hasSite(domain, 'reverse_proxy') && hasSite(`*.${domain}`, 'tls');
  } catch { return false; }
}

function askTarget(askUrl: string | undefined, permission: boolean, port: number): DomainStatus['caddy']['askTarget'] {
  if (permission) return 'invalid';
  if (!askUrl) return 'missing';
  if (askUrl === `http://127.0.0.1:${port}${ASK_PATH}`) return 'ok';
  const callback = /^http:\/\/127\.0\.0\.1:(\d+)\/api\/domain\/ask$/.exec(askUrl);
  const callbackPort = parsePort(callback?.[1]);
  return callbackPort && callbackPort !== port ? 'stale' : 'invalid';
}

export async function getDomainStatus(env: DomainEnv, dataDir: string): Promise<DomainStatus> {
  const { io, run } = caddyDependencies();
  const interfaces = serverNetworkInterfaces();
  const addresses = hostAddressList(interfaces);
  const live = safeConfig(env);
  const [stored, installed] = await Promise.all([
    readDomainSettings(env, dataDir, io).catch(() => null),
    caddyAvailable((file, args) => run(file, args, { timeout: 2000 })).catch(() => false),
  ]);
  const saved = stored ? safeConfig(stored.settings) : live;
  const config = live ?? saved;
  const panel = panelListen(env, addresses);
  const agents = currentAgentPortsListen(addresses, { env, saved: stored?.saved.REV4A_AGENT_PORTS_LISTEN });
  const port = parsePort(env.PORT) ?? 3740;
  const savedPort = parsePort(stored?.saved.PORT) ?? port;
  const runningMain = env.REV4A_CADDY_MAIN || DEFAULT_CADDY_MAIN;
  const runningFile = env.REV4A_CADDY_FILE || DEFAULT_CADDY_FILE;
  const savedMain = stored ? stored.settings.REV4A_CADDY_MAIN || DEFAULT_CADDY_MAIN : runningMain;
  const savedFile = stored ? stored.settings.REV4A_CADDY_FILE || DEFAULT_CADDY_FILE : runningFile;
  const setupChanged = savedPort !== port || savedMain !== runningMain || savedFile !== runningFile;
  const status: DomainStatus = {
    domain: config?.domain ?? null,
    enabled: live !== null,
    port,
    dataDir: resolve(dataDir),
    caddyMain: runningMain,
    caddyFile: runningFile,
    ...(setupChanged && { savedSetup: { port: savedPort, caddyMain: savedMain, caddyFile: savedFile } }),
    caddy: { installed, managedFile: 'missing', imported: false, onDemandAsk: false, askTarget: 'missing' },
    listen: { panel: panel.mode, agents: agents.hostIp === null ? 'keep' : agents.mode },
    routes: 0,
    restartPending: live?.domain !== saved?.domain || setupChanged,
    serverAddresses: serverAddresses(interfaces),
  };
  if (!config) return status;
  if (stored) {
    const nextPanel = listenAddresses(stored.settings.REV4A_LISTEN, { hostAddresses: addresses });
    status.restartPending ||= accessRestartPending(panel, {
      ...stored.settings, REV4A_LISTEN: nextPanel.address ?? nextPanel.mode,
    }, env);
  }

  const reserved = [resolve(dataDir, '.env'), resolve(dataDir, 'domain-auth.json')];
  const [managed, main] = await Promise.allSettled([
    reserved.includes(config.file) ? Promise.reject() : readSnapshot(io, config.file),
    reserved.includes(config.main) ? Promise.reject() : caddyMain(io, config),
  ]);
  if (managed.status === 'rejected') status.caddy.managedFile = 'unmanaged';
  else if (managed.value) {
    const { text } = managed.value;
    const routes = readManagedRoutes(text, config.domain);
    if (routes) {
      status.caddy.managedFile = hasManagedSites(text, config.domain) ? 'ok' : 'incomplete';
      if (status.caddy.managedFile === 'ok') status.routes = routes.size;
    } else {
      status.caddy.managedFile = isGenerated(text) ? 'pending' : 'unmanaged';
    }
  }
  if (main.status === 'fulfilled') {
    const { imports, askUrl, permission } = main.value;
    status.caddy.imported = hasCaddyImport(imports, config);
    status.caddy.askTarget = askTarget(askUrl, permission, port);
    status.caddy.onDemandAsk = status.caddy.askTarget === 'ok';
  }
  return status;
}
