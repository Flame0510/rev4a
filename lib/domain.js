'use strict';

const path = require('node:path');
const { CLIENT_IP_HEADER, SOCKET_PEER_HEADER, isLoopback } = require('./client-address.js');
const { LABEL, normalizeDomain, DEFAULT_CADDY_MAIN, DEFAULT_CADDY_FILE } = require('./domain-name.js');

const ASK_PATH = '/api/domain/ask';
const GENERATED = '# Managed by Rev4a; do not edit by hand. Configure with: rev4a domain setup';
const RELOAD_UNCONFIRMED = '# Rev4a reload unconfirmed\n';
const LEGACY_PENDING = '# Rev4a reload pending\n';
const DEV_USER = 'rev4a';
const BCRYPT = /^\$2[aby]\$1[0-4]\$[./A-Za-z0-9]{53}$/;
const DEV_SUFFIX = /-300[1-9]$/;

function canRouteAgent(state) {
  return state?.Running === true && state.Paused !== true && state.Restarting !== true;
}

function caddyPath(value, fallback) {
  const file = value || fallback;
  if (!path.isAbsolute(file) || file !== path.normalize(file) || !/^\/[A-Za-z0-9_./-]+$/.test(file) || file.endsWith('/')) {
    throw new Error('Caddyfile paths must be absolute, normalized filesystem paths without spaces or glob characters.');
  }
  return file;
}

function domainConfig(env) {
  const domain = normalizeDomain(env.REV4A_DOMAIN);
  if (!domain) return null;
  const main = caddyPath(env.REV4A_CADDY_MAIN, DEFAULT_CADDY_MAIN);
  const file = caddyPath(env.REV4A_CADDY_FILE, DEFAULT_CADDY_FILE);
  if (file === main) throw new Error('REV4A_CADDY_FILE must be separate from REV4A_CADDY_MAIN.');
  const port = parsePort(env.PORT || '3740');
  if (!port) throw new Error('PORT must be a valid dashboard port.');
  return { domain, file, main, port, askUrl: `http://127.0.0.1:${port}${ASK_PATH}` };
}

function parsePort(value) {
  const text = String(value ?? '');
  const port = Number(text);
  return /^\d{1,5}$/.test(text) && port > 0 && port <= 65535 ? port : null;
}

function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
}

function agentBase(agent) {
  return slug(agent.displayName) || slug(agent.containerName) || 'agent';
}

function portFromBindings(bindings) {
  // The generated upstream uses IPv4 loopback. An explicit address elsewhere
  // can have a different service listening on the same port at 127.0.0.1.
  const ipv4 = ['', '0.0.0.0', '127.0.0.1'];
  for (const binding of bindings ?? []) {
    if (binding && ipv4.includes(binding.HostIp ?? '')) {
      const port = parsePort(binding.HostPort);
      if (port) return port;
    }
  }
  return null;
}

function agentHostPort(agent, containerPort) {
  if (!agent.running) return null;
  return portFromBindings(agent.activeBindings?.[`${containerPort}/tcp`]);
}

/** Allocate all ten host labels together so a Control UI can never shadow a dev port. */
function buildNameTable(agents, previous = new Map(), dashboardPort = 3740, retired = new Set()) {
  const ordered = agents.map(agent => {
    const time = Date.parse(agent.created);
    return { agent, time: Number.isFinite(time) ? time : Infinity };
  }).sort((a, b) => a.time - b.time
    || (a.agent.id ?? a.agent.containerName).localeCompare(b.agent.id ?? b.agent.containerName))
    .map(({ agent }) => agent);
  const occupied = new Set();
  const assigned = new Map();
  const remembered = new Map(previous);
  const retiredNames = new Set([...retired].filter(name => !DEV_SUFFIX.test(name)));
  const bases = new Map(ordered.map(agent => [agent.containerName, agentBase(agent)]));
  const previousById = new Map();
  for (const [container, assignment] of previous) {
    if (assignment.id) previousById.set(assignment.id, { container, assignment });
  }

  function reserveLabel(name) {
    const labels = [name, ...Array.from({ length: 9 }, (_, i) => `${name}-${3001 + i}`)];
    if (labels.some(label => occupied.has(label))) return false;
    labels.forEach(label => occupied.add(label));
    return true;
  }

  function reserve(agent, base, name) {
    if (!reserveLabel(name)) return false;
    const id = /^[\w.-]+$/.test(agent.agentId ?? '') ? agent.agentId : undefined;
    assigned.set(agent.containerName, { base, name, ...(id ? { id } : {}) });
    return true;
  }

  function reserveSaved(agent, base, saved) {
    return saved.name.length <= 40 && LABEL.test(saved.name) && !DEV_SUFFIX.test(saved.name)
      && reserve(agent, base, saved.name);
  }

  for (const name of retiredNames) reserveLabel(name);
  for (const agent of ordered) {
    const base = bases.get(agent.containerName);
    const saved = previous.get(agent.containerName);
    if (saved?.base === base && (!saved.id || saved.id === agent.agentId)) reserveSaved(agent, base, saved);
  }
  for (const agent of ordered) {
    if (assigned.has(agent.containerName)) continue;
    const saved = previousById.get(agent.agentId);
    if (!saved || saved.container === agent.containerName) continue;
    const base = bases.get(agent.containerName);
    // Without a display name, the base can change solely because Recreate changed the Docker name.
    if ((saved.assignment.base === base || !slug(agent.displayName)) && reserveSaved(agent, base, saved.assignment)) {
      remembered.delete(saved.container);
      previousById.delete(agent.agentId);
    }
  }
  for (const [container, { name }] of remembered) {
    if (!bases.has(container) && (DEV_SUFFIX.test(name) || !reserveLabel(name))) remembered.delete(container);
  }
  for (const agent of ordered) {
    if (assigned.has(agent.containerName)) continue;
    const base = bases.get(agent.containerName);
    const reservedSuffix = DEV_SUFFIX.test(base) ? '-agent' : '';
    for (let index = 1; ; index++) {
      const suffix = index === 1 ? '' : `-${index}`;
      const name = base.slice(0, 40 - reservedSuffix.length - suffix.length).replace(/-$/, '') + reservedSuffix + suffix;
      if (DEV_SUFFIX.test(name)) continue;
      if (reserve(agent, base, name)) break;
    }
  }

  // Remember names across the short gap between removing and replacing a container.
  // Missing containers retain a label but never contribute routes.
  for (const [container, assignment] of assigned) remembered.set(container, assignment);

  const routes = [];
  const portOwners = new Map();
  for (const agent of ordered) {
    const { name } = assigned.get(agent.containerName);
    for (let containerPort = 3000; containerPort <= 3009; containerPort++) {
      const hostPort = agentHostPort(agent, containerPort);
      if (!hostPort || hostPort === dashboardPort) continue;
      const dev = containerPort !== 3000;
      const route = dev
        ? { name: `${name}-${containerPort}`, hostPort, dev }
        : { name, hostPort, dev, displayName: agent.displayName };
      routes.push(route);
      portOwners.set(hostPort, (portOwners.get(hostPort) ?? 0) + 1);
    }
  }
  // Keep rendering order stable even when Recreate changes a container's timestamp.
  return {
    assignments: new Map([...remembered].sort(([a], [b]) => a.localeCompare(b))),
    retired: retiredNames,
    routes: routes.filter(route => portOwners.get(route.hostPort) === 1).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function clearReloadMarker(content) {
  if (content.endsWith('\n' + RELOAD_UNCONFIRMED)) return content.slice(0, -RELOAD_UNCONFIRMED.length);
  if (content.startsWith(LEGACY_PENDING)) {
    return content.slice(LEGACY_PENDING.length).replace(/^# Rev4a pending port: \d+\n/gm, '');
  }
  return content;
}

function isGenerated(content) {
  return clearReloadMarker(content).startsWith(GENERATED + '\n');
}

function readAssignments(content, domain) {
  const assignments = new Map();
  if (!content?.includes(`${GENERATED}\n# Rev4a domain: ${domain}\n`)) return assignments;
  for (const match of content.matchAll(/^# Rev4a agent: ([\w.-]+) ([a-z0-9-]+) ([a-z0-9-]+)$/gm)) {
    assignments.set(match[1], { base: match[2], name: match[3] });
  }
  for (const [, container, id] of content.matchAll(/^# Rev4a agent id: ([\w.-]+) ([\w.-]+)$/gm)) {
    const assignment = assignments.get(container);
    if (assignment) assignment.id = id;
  }
  return assignments;
}

function readRetiredLabels(content, domain) {
  const retired = new Set();
  if (content?.includes(`${GENERATED}\n# Rev4a domain: ${domain}\n`)) {
    for (const [, label] of content.matchAll(/^# Rev4a retired: ([a-z0-9-]+)$/gm)) {
      if (label.length <= 40 && LABEL.test(label) && !DEV_SUFFIX.test(label)) retired.add(label);
    }
  }
  return retired;
}

/** Published routes from a generated file after its Caddy reload has finished. */
function readManagedRoutes(content, domain) {
  if (!content.startsWith(`${GENERATED}\n# Rev4a domain: ${domain}\n`) || content.endsWith('\n' + RELOAD_UNCONFIRMED)) return null;
  const routes = new Map();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\t@([a-z0-9-]+) host (\S+)$/.exec(lines[i]);
    if (!match) continue;
    const [, label, host] = match;
    if (!LABEL.test(label) || host !== `${label}.${domain}` || lines[i + 1] !== `\thandle @${label} {`) continue;
    const end = lines.indexOf('\t}', i + 2);
    if (end === -1) continue;
    const upstream = lines.slice(i + 2, end)
      .map(line => /^\t\treverse_proxy 127\.0\.0\.1:(\d+) \{$/.exec(line))
      .find(Boolean);
    const port = parsePort(upstream?.[1]);
    if (port) routes.set(label, port);
    i = end;
  }
  return routes;
}

/** Ports from a managed file, including the candidate after an unconfirmed reload. */
function readRouteReservations(content) {
  const candidate = clearReloadMarker(content);
  if (!candidate.startsWith(GENERATED + '\n')) return { routes: new Map(), dashboardPort: null };
  const domain = /^# Rev4a domain: ([a-z0-9.-]+)$/m.exec(candidate)?.[1];
  const routes = (domain ? readManagedRoutes(candidate, domain) : null) ?? new Map();
  const lines = candidate.split('\n');
  const dashboard = lines.indexOf(`${domain} {`);
  const dashboardPort = dashboard === -1 ? null
    : parsePort(/^\treverse_proxy 127\.0\.0\.1:(\d+)$/.exec(lines[dashboard + 1])?.[1]);
  return { routes, dashboardPort };
}

function caddyJson(value) {
  // Hide Caddy delimiters and keep Unicode line separators out of managed-file metadata scans.
  return JSON.stringify(value).replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, token =>
    token.replace(/[{}\x60\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

function agentManifest(label, name) {
  return caddyJson({
    name,
    short_name: Array.from(name).slice(0, 12).join(''),
    id: `/?rev4a-agent=${label}`,
    start_url: './',
    scope: './',
    display: 'standalone',
    theme_color: '#0a0a0a',
    background_color: '#0a0a0a',
    description: `${name} · OpenClaw agent (Rev4a)`,
    icons: [
      { src: './favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: './favicon-32.png', sizes: '32x32', type: 'image/png' },
      { src: './apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  });
}

function renderCaddyfile(config, table, hash) {
  const { domain, port } = config;
  const lines = [GENERATED, `# Rev4a domain: ${domain}`];
  for (const [container, { base, name, id }] of table.assignments) {
    lines.push(`# Rev4a agent: ${container} ${base} ${name}`);
    // Keep the original assignment line readable by builds that predate agent ID metadata.
    if (id) lines.push(`# Rev4a agent id: ${container} ${id}`);
  }
  for (const name of [...(table.retired ?? [])].sort()) lines.push(`# Rev4a retired: ${name}`);
  lines.push('', `${domain} {`, `\treverse_proxy 127.0.0.1:${port}`, '}', '',
    `*.${domain} {`, '\ttls {', '\t\ton_demand', '\t}', '');
  // OpenClaw's gateway refuses any request carrying X-Forwarded-* unless gateway.trustedProxies is
  // configured in the agent ("proxy_attribution_required", 403, seen on 2026.10.10). Caddy adds them by
  // default, so they are removed for every agent upstream: the Control UI keeps its own token + device
  // pairing, and nothing inside the agent has to change.
  const STRIP = ['\t\t\theader_up -X-Forwarded-For', '\t\t\theader_up -X-Forwarded-Proto', '\t\t\theader_up -X-Forwarded-Host'];
  for (const { name, hostPort, dev, displayName } of table.routes) {
    lines.push(`\t@${name} host ${name}.${domain}`, `\thandle @${name} {`);
    if (dev) {
      if (!BCRYPT.test(hash ?? '')) throw new Error('A bcrypt hash is required for dev ports.');
      lines.push('\t\tbasic_auth {', `\t\t\t${DEV_USER} ${hash}`, '\t\t}');
    } else {
      // An underscore keeps this matcher's name distinct from every host matcher.
      const manifest = `@${name}_manifest`;
      lines.push(`\t\t${manifest} path /manifest.webmanifest`,
        `\t\theader ${manifest} Content-Type "application/manifest+json"`,
        `\t\theader ${manifest} Cache-Control "no-cache"`,
        `\t\trespond ${manifest} \`${agentManifest(name, displayName || name)}\` 200`);
    }
    lines.push(`\t\treverse_proxy 127.0.0.1:${hostPort} {`, ...(dev ? ['\t\t\theader_up -Authorization'] : []), ...STRIP, '\t\t}');
    lines.push('\t}', '');
  }
  lines.push('\thandle {', '\t\trespond 404', '\t}', '}', '');
  return lines.join('\n');
}

/** Only the direct Caddy callback can ask. Reject forwarded requests even if proxy trust is unset. */
async function domainAsk(request, env, readFile, checkAgentRoute) {
  if (env.REV4A_SUPERVISED !== '1' || !isLoopback(request.headers.get(SOCKET_PEER_HEADER))
      || !isLoopback(request.headers.get(CLIENT_IP_HEADER))) return 404;
  try {
    const config = domainConfig(env);
    if (!config || request.headers.get('host') !== `127.0.0.1:${config.port}`) return 404;
    const domains = new URL(request.url).searchParams.getAll('domain');
    if (domains.length !== 1) return 404;
    const name = domains[0].toLowerCase();
    if (name === config.domain) return 200;
    const suffix = `.${config.domain}`;
    if (!name.endsWith(suffix)) return 404;
    const label = name.slice(0, -suffix.length);
    if (!LABEL.test(label)) return 404;
    const content = await readFile(config.file, 'utf8');
    const port = readManagedRoutes(content, config.domain)?.get(label);
    if (!port) return 404;

    // Certificates for a stale route must be refused even before the next sync.
    for (const [container, assignment] of readAssignments(content, config.domain)) {
      const suffix = label.slice(assignment.name.length);
      if (!label.startsWith(assignment.name) || (suffix && !/^-300[1-9]$/.test(suffix))) continue;
      const containerPort = suffix ? Number(suffix.slice(1)) : 3000;
      return await checkAgentRoute({ container, base: assignment.base, containerPort, hostPort: port }) ? 200 : 404;
    }
    return 404;
  } catch {
    return 404;
  }
}

/** A managed file with no sites: a valid import target while nothing else can be written. */
function emptyCaddyfile() {
  return `${GENERATED}\n`;
}

module.exports = {
  emptyCaddyfile,
  ASK_PATH, BCRYPT, DEV_USER, RELOAD_UNCONFIRMED, agentBase, agentHostPort, buildNameTable, canRouteAgent, clearReloadMarker,
  domainAsk, domainConfig, isGenerated, normalizeDomain, parsePort, readAssignments, readManagedRoutes, readRetiredLabels,
  readRouteReservations, renderCaddyfile,
};
