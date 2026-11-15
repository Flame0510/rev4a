/** Fixed native destinations only. Callers cannot choose a host, scheme or arbitrary redirect. */
import { isValidCronJobId } from './cron-ids';

/** Same public ID shape as lib/container.ts, without importing its server-only child_process code. */
export const isControlUiAgentId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);

/** No job preserves the exact existing link, including its authentication fragment. */
export function controlUiAutomationUrl(baseUrl: string, jobId?: string | null): string {
  if (jobId == null) return baseUrl;
  if (!isValidCronJobId(jobId)) throw new Error('Invalid automation job id');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid Control UI link'); }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/automations`;
  url.searchParams.set('job', jobId);
  return url.toString();
}

/** Navigate through Rev4a so native one-time/browser authentication remains server-side. */
export function controlUiOpenPath(agentId: string, jobId?: string): string {
  const path = `/api/agents/${encodeURIComponent(agentId)}/open-control-ui`;
  if (jobId === undefined) return path;
  if (!isValidCronJobId(jobId)) throw new Error('Invalid automation job id');
  return `${path}?${new URLSearchParams({ job: jobId }).toString()}`;
}

/** Only the reproduced ownership refusal, not an arbitrary billing/login/delivery error. */
export function isMissingInferenceAccountError(error: unknown): boolean {
  return typeof error === 'string'
    && /^(?:Error: )?Automation has no recorded inference account\.(?:\s|$)/.test(error.trim());
}

/** Only the evaluated source-to-target upgrade needs this migration notice. */
export function needsInferenceAccountAdoptionNotice(fromVersion: unknown, toVersion: unknown): boolean {
  return (fromVersion === '2026.9.3' || fromVersion === '2026.9.9') && toVersion === '2026.10.10';
}

/** Same loopback rule as `controlUiHostFor` in lib/agent-devices.ts (server-only): these hosts get an isolated link. */
function isLoopbackHost(hostname: string): boolean {
  if (/^localhost\.?$/i.test(hostname) || hostname === '::1' || hostname === '[::1]') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every((part) => Number(part) <= 255);
}

/**
 * True when opening an agent from this page also sends the Rev4a session to the agent's port:
 * plain HTTP on a host that is not isolated. Cookies ignore ports; HTTPS cookies are Secure
 * and never go to an `http:` agent port.
 */
export function controlUiExposesSession(protocol: string, hostname: string): boolean {
  return protocol === 'http:' && !isLoopbackHost(hostname);
}

/**
 * True when the agent's Control UI port is published on an address this browser cannot use, so
 * the plain link cannot work (REV4A_AGENT_PORTS_LISTEN): bound to loopback while the dashboard
 * is reached on another host, or bound to one IP that is not the dashboard's own (compared only
 * when the dashboard host is an IP; a name cannot be compared, so the link is tried). A loopback
 * dashboard is the same machine as the port: always reachable. Every protocol, https included.
 */
export function controlUiPortLocalOnly(hostIp: string | null | undefined, dashboardHost: string): boolean {
  const ip = String(hostIp ?? '').trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!ip || ip === '0.0.0.0' || ip === '::') return false;
  if (isLoopbackHost(dashboardHost)) return false;
  if (isLoopbackHost(ip)) return true;
  const host = dashboardHost.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
  return isIpLiteral && host !== ip;
}

/**
 * The SSH command that forwards the agent's port to this computer. In `user@host` OpenSSH wants an
 * IPv6 address without brackets (with them it looks the bracketed text up as a name), and an
 * unbracketed command also survives zsh, where `[` starts a glob. `targetIp` is the address the
 * port is published on, when it is not loopback (REV4A_AGENT_PORTS_LISTEN=<IP>).
 */
export function controlUiTunnelCommand(port: string, hostname: string, targetIp?: string | null): string {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  const target = String(targetIp ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  // Loopback targets are used as they are (::1, 127.0.0.2): the port is published on exactly that address.
  const to = !target || target === '0.0.0.0' || target === '::' ? '127.0.0.1' : (target.includes(':') ? `[${target}]` : target);
  const forward = `${port}:${to}:${port}`;
  // Brackets would be a glob in zsh: quote the argument that has them.
  return `ssh -L ${forward.includes('[') ? `'${forward}'` : forward} user@${host}`;
}

/**
 * The tunnel route: JSON with the link built for localhost instead of a redirect. `port` asks only
 * for the agent's published port, so opening the dialog never issues a one-time link.
 */
export function controlUiTunnelPath(agentId: string, jobId?: string, what: 'link' | 'port' = 'link'): string {
  if (what === 'port') return `/api/agents/${encodeURIComponent(agentId)}/open-control-ui?tunnel=port`;
  const params = new URLSearchParams({ tunnel: '1' });
  if (jobId !== undefined) {
    if (!isValidCronJobId(jobId)) throw new Error('Invalid automation job id');
    params.set('job', jobId);
  }
  return `/api/agents/${encodeURIComponent(agentId)}/open-control-ui?${params.toString()}`;
}
