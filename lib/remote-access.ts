/** Pure preset/guard decisions shared by System, first run and the server. */
import { isLoopbackHost } from './control-ui-navigation';
export { isLoopbackHost } from './control-ui-navigation';
export type AccessPreset = 'local' | 'direct' | 'domain';
export type AccessSettings = { REV4A_LISTEN?: string; REV4A_AGENT_PORTS_LISTEN?: string; REV4A_TRUSTED_PROXIES?: string };
export const REMOTE_ACCESS_GUIDE = 'https://rev4a.app/en/docs/remote-access';
export const PRESETS: { id: AccessPreset; title: string; description: string }[] = [
  { id: 'local', title: 'This computer only', description: 'Rev4a and its agents answer only on this computer.' },
  { id: 'direct', title: 'Direct (IP)', description: 'As before: reachable from the network over plain HTTP.' },
  { id: 'domain', title: 'Domain (your own proxy)', description: 'For a reverse proxy (Caddy, nginx, Traefik) or Tailscale on this server' },
];

export function presetEdits(preset: AccessPreset, settings: AccessSettings): Record<string, string> {
  const edits: Record<string, string> = { REV4A_LISTEN: preset === 'direct' ? 'all' : 'local', REV4A_AGENT_PORTS_LISTEN: preset === 'direct' ? 'all' : 'local' };
  if (preset === 'domain') {
    let proxies = settings.REV4A_TRUSTED_PROXIES || '';
    for (const ip of ['127.0.0.1', '::1']) {
      if (!proxies.split(',').map((entry) => entry.trim()).includes(ip)) proxies += `${proxies && !proxies.trimEnd().endsWith(',') ? ',' : ''}${ip}`;
    }
    edits.REV4A_TRUSTED_PROXIES = proxies;
  }
  return edits;
}

const bareHost = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '');
export function presetGuard(preset: AccessPreset, location: { protocol: string; hostname: string; port?: string }): { allowed: boolean; needsConfirm: boolean; reason: string } {
  if (preset === 'local' && !isLoopbackHost(location.hostname)) return { allowed: false, needsConfirm: false, reason: 'You are connected from another device; this would cut you off. Use an SSH tunnel or a domain first.' };
  const host = bareHost(location.hostname);
  if (preset === 'local' && host.startsWith('127.') && host !== '127.0.0.1') {
    const port = /^\d{1,5}$/.test(location.port || '') ? `:${location.port}` : '';
    return { allowed: false, needsConfirm: false, reason: `This loopback address will stop answering. Open http://127.0.0.1${port} before applying This computer only.` };
  }
  return { allowed: true, needsConfirm: preset === 'domain', reason: '' };
}

/** Active panel plus saved keys: unset/unset is Default; unmatched mixtures are Custom. */
export function currentAccessMode(panelMode: string, agentMode: string, settings: AccessSettings): AccessPreset | 'custom' | 'default' {
  const panel = settings.REV4A_LISTEN?.trim().toLowerCase();
  const agents = settings.REV4A_AGENT_PORTS_LISTEN?.trim().toLowerCase();
  if (panelMode === 'all' && agentMode === 'keep' && !panel && !agents) return 'default';
  if (panelMode === 'all' && agentMode === 'all' && panel === 'all' && agents === 'all') return 'direct';
  if (panelMode === 'local' && agentMode === 'local' && panel === 'local' && agents === 'local') {
    const proxies = (settings.REV4A_TRUSTED_PROXIES || '').split(',').map((s) => s.trim());
    return proxies.includes('127.0.0.1') && proxies.includes('::1') ? 'domain' : 'local';
  }
  return 'custom';
}
export function showLanNotice(hostname: string, panelMode: string): boolean {
  return isLoopbackHost(hostname) && panelMode === 'all';
}

/** Custom one-IP listeners must not look like a permanently pending restart. */
export function panelRestartPending(panel: { mode: string; addresses: string[] }, setting?: string): boolean {
  const wanted = setting?.trim().toLowerCase() || 'all';
  if (wanted === 'all' || wanted === 'local') return panel.mode !== wanted;
  return panel.mode !== 'address' || !panel.addresses.some((address) => bareHost(address) === bareHost(wanted));
}

/** The server's proxy matcher is constructed once at startup, independently of its listeners. */
export function accessRestartPending(panel: { mode: string; addresses: string[] }, saved: AccessSettings, startup: AccessSettings): boolean {
  const proxies = (value?: string) => [...new Set((value || '').split(',').map((entry) => entry.trim()).filter(Boolean))].sort().join(',');
  return panelRestartPending(panel, saved.REV4A_LISTEN) || proxies(saved.REV4A_TRUSTED_PROXIES) !== proxies(startup.REV4A_TRUSTED_PROXIES);
}
