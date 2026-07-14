import { networkInterfaces } from 'os';

/**
 * Detect the host's best public-facing IPv4 address for no-Traefik agent URLs.
 * Falls back to 'localhost' on machines with no public interface (e.g. dev laptop).
 */
export function detectPublicHost(): string {
  try {
    const ifaces = networkInterfaces();
    for (const [, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
  } catch { /* fall through */ }
  return 'localhost';
}

/**
 * Build the provider gateway base URL used to sync model config into agent
 * containers. When OLYMPUS_DOMAIN is set (Traefik mode), the subdomain
 * https://olympus.<domain> is used. When no domain is configured, agents
 * reach the gateway through the Docker host gateway (host.docker.internal)
 * injected at container creation via --add-host.
 */
export function detectProviderGatewayUrl(): string {
  const domain = process.env.OLYMPUS_DOMAIN || '';
  if (domain) {
    return `https://olympus.${domain}/api/provider/v1`;
  }
  // No domain: agents reach Olympus through the Docker host gateway.
  // The host.docker.internal hostname is injected via --add-host at container
  // creation and resolves to the Docker bridge gateway IP.
  return 'http://host.docker.internal:3740/api/provider/v1';
}
