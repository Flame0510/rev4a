/**
 * Browser access to an agent's Control UI: requests waiting for approval, the
 * browsers already approved, and the one-time link that opens the Control UI
 * without an approval.
 *
 * Everything goes through the OpenClaw CLI inside the container, called with the
 * async `dockerExec`, so a slow agent never holds the event loop. The CLI talks to
 * the agent's own Gateway on port 3000. The token is resolved inside the container
 * with the entrypoint's precedence — `/root/.agent-token`, then the container's
 * `OPENCLAW_GATEWAY_TOKEN` — so it never reaches argv on the host.
 *
 * Browser approval is part of OpenClaw 9.x, the only major this build supports. An
 * agent whose Gateway cannot be read answers "unknown" rather than guessing.
 */
import { dockerExec, dockerExecNoFail } from '@/lib/docker-exec';
import { dockerFetch } from '@/lib/docker-socket';
import { isValidAgentId } from '@/lib/container';
import { gatewayCliArgv } from '@/lib/gateway-cli';

const CLI_TIMEOUT_MS = 20_000;
const LINK_TIMEOUT_MS = 30_000;
const CONFIG_TIMEOUT_MS = 8_000;

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const HOSTNAME_RE = /^(\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]{2,45}|[A-Za-z0-9.-]{1,253})$/;
const MAX_NAME_LENGTH = 64;

export const isRequestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID_RE.test(v);
export const isDeviceId = (v: unknown): v is string => typeof v === 'string' && DEVICE_ID_RE.test(v);
export const isHostname = (v: unknown): v is string => typeof v === 'string' && HOSTNAME_RE.test(v);

/** A device label: trimmed, printable, at most 64 characters. Null when unusable. */
export function cleanDeviceName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export interface AgentContainer {
  name: string;
  running: boolean;
  /** Host port published for the Gateway's port 3000, if any. */
  controlPort: string | null;
}

interface DockerContainer {
  Names?: string[];
  State?: string;
  Labels?: Record<string, string>;
  Ports?: { PrivatePort?: number; PublicPort?: number }[];
}

/** The container carrying `AGENT_ID=<agentId>`, through the Docker API rather than a blocking `docker ps`. */
export async function findAgentContainer(agentId: string): Promise<AgentContainer | null> {
  if (!isValidAgentId(agentId)) return null;
  const filters = encodeURIComponent(JSON.stringify({ label: [`AGENT_ID=${agentId}`] }));
  const list = await dockerFetch<DockerContainer[]>('GET', `/containers/json?all=true&filters=${filters}`);
  const c = Array.isArray(list) ? list[0] : undefined;
  if (!c) return null;
  const port = (c.Ports ?? []).find((p) => p.PrivatePort === 3000 && p.PublicPort)?.PublicPort;
  return {
    name: (c.Names?.[0] ?? '').replace(/^\//, ''),
    running: c.State === 'running',
    controlPort: port ? String(port) : null,
  };
}

/** Running agent containers, for the fleet summary. */
export async function listRunningAgentContainers(): Promise<{ agentId: string; name: string }[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: ['AGENT_ID'] }));
  const list = await dockerFetch<DockerContainer[]>('GET', `/containers/json?filters=${filters}`);
  return (Array.isArray(list) ? list : [])
    .filter((c) => c.State === 'running' && c.Labels?.AGENT_ID)
    .map((c) => ({ agentId: c.Labels!.AGENT_ID, name: (c.Names?.[0] ?? '').replace(/^\//, '') }));
}

/**
 * The JSON document in the CLI's output. `docker exec` resolves with partial output
 * when it hits its deadline, so a document that does not parse is treated as a
 * failure, never as an empty answer.
 */
function parseCliJson(output: string): unknown {
  const start = output.search(/[{[]/);
  const end = Math.max(output.lastIndexOf('}'), output.lastIndexOf(']'));
  if (start === -1 || end < start) throw new Error('OpenClaw returned no JSON');
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error('OpenClaw returned incomplete JSON');
  }
}

async function runCli(container: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<unknown> {
  const out = await dockerExec(container, gatewayCliArgv(args), { timeoutMs });
  return parseCliJson(out);
}

/** True when the Gateway answers `/startupz` with JSON carrying its version: a 9.x Gateway. */
async function answersStartupzWithVersion(container: string): Promise<boolean> {
  const probe = await dockerExecNoFail(container, ['curl', '-s', '--max-time', '3', 'http://127.0.0.1:3000/startupz'], { timeoutMs: CONFIG_TIMEOUT_MS });
  try {
    return typeof (JSON.parse(probe) as { version?: unknown })?.version === 'string';
  } catch {
    // Not JSON (a 9.x Gateway that is still starting answers 503, and a stopped agent
    // answers nothing): the version cannot be read.
    return false;
  }
}

/**
 * Whether browsers need approval on this agent. Every supported OpenClaw answers
 * `/startupz` with a JSON document carrying its version, and there approval always
 * applies. Null when the Gateway cannot be read, so callers can answer "unknown"
 * instead of guessing.
 */
export async function requiresBrowserApproval(container: string): Promise<boolean | null> {
  return (await answersStartupzWithVersion(container)) ? true : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface PendingBrowser {
  requestId: string;
  deviceId: string;
  displayName: string | null;
  platform: string | null;
  clientId: string | null;
  clientMode: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  browserOrigin: string | null;
  /** A known device asking for a broader role or scope set. */
  isRepair: boolean;
  requestedAtMs: number | null;
}

export interface ApprovedBrowser {
  deviceId: string;
  /** Operator label, else the name the client reported. */
  label: string | null;
  platform: string | null;
  clientId: string | null;
  clientMode: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  /** `silent` (local auto-approval), `owner` (approved by an operator), `bootstrap` (one-time link), … */
  approvedVia: string | null;
  createdAtMs: number | null;
  approvedAtMs: number | null;
  lastUsedAtMs: number | null;
}

export interface BrowserAccess {
  requiresApproval: boolean | null;
  pending: PendingBrowser[];
  approved: ApprovedBrowser[];
}

function toPending(r: Record<string, unknown>): PendingBrowser | null {
  const requestId = str(r.requestId);
  const deviceId = str(r.deviceId);
  if (!requestId || !deviceId) return null;
  return {
    requestId,
    deviceId,
    displayName: str(r.displayName),
    platform: str(r.platform),
    clientId: str(r.clientId),
    clientMode: str(r.clientMode),
    roles: strings(r.roles).length ? strings(r.roles) : strings([r.role]),
    scopes: strings(r.scopes),
    remoteIp: str(r.remoteIp),
    browserOrigin: str(r.browserOrigin),
    isRepair: r.isRepair === true,
    requestedAtMs: num(r.ts),
  };
}

function toApproved(d: Record<string, unknown>): ApprovedBrowser | null {
  const deviceId = str(d.deviceId);
  if (!deviceId) return null;
  const tokenUse = (Array.isArray(d.tokens) ? d.tokens : [])
    .map((t) => num((t as Record<string, unknown>)?.lastUsedAtMs))
    .filter((t): t is number => t !== null);
  return {
    deviceId,
    label: str(d.operatorLabel) ?? str(d.displayName),
    platform: str(d.platform),
    clientId: str(d.clientId),
    clientMode: str(d.clientMode),
    roles: strings(d.roles).length ? strings(d.roles) : strings([d.role]),
    scopes: strings(d.scopes),
    remoteIp: str(d.remoteIp),
    approvedVia: str(d.approvedVia),
    createdAtMs: num(d.createdAtMs),
    approvedAtMs: num(d.approvedAtMs),
    lastUsedAtMs: tokenUse.length ? Math.max(...tokenUse) : num(d.lastSeenAtMs) ?? num(d.lastConnectedAtMs),
  };
}

/** Pending requests and approved browsers of one running agent. Throws when the CLI fails. */
export async function listBrowserAccess(container: string): Promise<BrowserAccess> {
  const requiresApproval = await requiresBrowserApproval(container);
  if (requiresApproval === false) return { requiresApproval, pending: [], approved: [] };
  const raw = (await runCli(container, ['devices', 'list', '--json'])) as { pending?: unknown; paired?: unknown };
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  return {
    requiresApproval,
    pending: rows(raw?.pending).map(toPending).filter((x): x is PendingBrowser => x !== null),
    approved: rows(raw?.paired).map(toApproved).filter((x): x is ApprovedBrowser => x !== null),
  };
}

export async function approveBrowser(container: string, requestId: string): Promise<void> {
  await runCli(container, ['devices', 'approve', requestId, '--json']);
}

export async function rejectBrowser(container: string, requestId: string): Promise<void> {
  await runCli(container, ['devices', 'reject', requestId, '--json']);
}

/** Removes the pairing: that browser needs approval again on its next connection. */
export async function removeBrowser(container: string, deviceId: string): Promise<void> {
  await runCli(container, ['devices', 'remove', deviceId, '--json']);
}

export async function renameBrowser(container: string, deviceId: string, name: string): Promise<void> {
  await runCli(container, ['devices', 'rename', '--device', deviceId, '--name', name, '--json']);
}

/**
 * A one-time Control UI link that pairs the browser opening it, with no approval.
 *
 * `openclaw dashboard --json` issues a ten-minute, single-use bootstrap token and
 * returns `browserUrl` aimed at the Gateway's own listener (`127.0.0.1:3000`), with
 * the WebSocket destination in the `gatewayUrl` fragment parameter. Both are
 * rewritten to the selected Control UI host and the agent's published port,
 * which is where the browser can actually connect.
 */
export async function issueControlUiLink(
  container: string,
  hostname: string,
  port: string,
): Promise<{ url: string; expiresAtMs: number | null }> {
  const data = (await runCli(container, ['dashboard', '--json'], LINK_TIMEOUT_MS)) as Record<string, unknown>;
  const browserUrl = str(data?.browserUrl);
  if (data?.ok !== true || !browserUrl) throw new Error(str(data?.reason) ?? 'OpenClaw did not issue a browser link');

  const host = hostForUrl(hostname);
  const [base, fragment = ''] = browserUrl.split('#');
  const url = new URL(base);
  url.hostname = host;
  url.port = port;

  const params = new URLSearchParams(fragment);
  const gatewayUrl = params.get('gatewayUrl');
  if (gatewayUrl) {
    const ws = new URL(gatewayUrl);
    ws.hostname = host;
    ws.port = port;
    params.set('gatewayUrl', ws.toString().replace(/\/$/, ''));
  }
  return { url: `${url.toString()}#${params.toString()}`, expiresAtMs: num(data.browserBootstrapExpiresAtMs) };
}

/** An IPv6 literal needs brackets inside a URL. */
function hostForUrl(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

/** Use a different loopback cookie host: browsers share cookies across ports. */
export function controlUiHostFor(dashboardHost: string): { host: string; isolated: boolean } {
  if (/^localhost\.?$/i.test(dashboardHost)) {
    return { host: '127.0.0.1', isolated: true };
  }
  // localhost resolves to both loopback families, including IPv6-only publishes.
  if (dashboardHost === '::1' || dashboardHost === '[::1]') {
    return { host: 'localhost', isolated: true };
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(dashboardHost)
    && dashboardHost.split('.').every((part) => Number(part) <= 255)) {
    return { host: 'localhost', isolated: true };
  }
  return { host: dashboardHost, isolated: false };
}

/** The hostname in a `Host` header value — the address the dashboard was reached on. */
export function hostnameFromHostHeader(host: string | null): string | null {
  if (!host) return null;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return isHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/** The token the Gateway was started with, read inside the container with the entrypoint's precedence. */
const READ_GATEWAY_TOKEN =
  'if [ -f /root/.agent-token ]; then head -1 /root/.agent-token | tr -d "[:space:]"; else printf %s "$OPENCLAW_GATEWAY_TOKEN"; fi';

/**
 * The token a plain Control UI link carries, read from the container rather than from
 * Rev4a's copy, so it is the one the Gateway checks even after the shared token changed
 * while the agent was stopped.
 */
async function readGatewayToken(container: string): Promise<string | null> {
  try {
    const token = (await dockerExec(container, ['sh', '-c', READ_GATEWAY_TOKEN], { timeoutMs: CONFIG_TIMEOUT_MS })).trim();
    return token && token !== 'undefined' ? token : null;
  } catch {
    return null;
  }
}

const plainLink = (hostname: string, port: string, token: string) =>
  `http://${hostForUrl(hostname)}:${port}/#token=${encodeURIComponent(token)}`;

/**
 * Where "Open" should take the browser: the one-time link, which pairs the browser with
 * no approval, else the plain token link when no one-time link could be issued.
 * Both use a separate cookie host when the dashboard is reached on loopback.
 */
export async function resolveControlUiUrl(
  container: string,
  hostname: string,
  port: string,
): Promise<{ url: string; kind: 'one-time' | 'token'; isolated: boolean }> {
  const { host, isolated } = controlUiHostFor(hostname);
  if (await answersStartupzWithVersion(container)) {
    try {
      return { url: (await issueControlUiLink(container, host, port)).url, kind: 'one-time', isolated };
    } catch {
      // Fall back to the plain link below.
    }
  }
  const token = await readGatewayToken(container);
  if (!token) throw new Error('no one-time link could be issued and no gateway token is available');
  return { url: plainLink(host, port, token), kind: 'token', isolated };
}

/**
 * A Control UI link for someone else: the plain token link. On an agent that requires
 * browser approval it gets past gateway auth only; the browser then waits for approval.
 */
export async function buildInviteLink(container: string, hostname: string, port: string): Promise<string> {
  const token = await readGatewayToken(container);
  if (!token) throw new Error('The agent has no readable gateway token');
  return plainLink(hostname, port, token);
}
