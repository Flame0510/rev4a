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
 * https://olympus.<domain> is used. Otherwise, fall back to the host's public
 * IP on port 3740 (direct mode, no HTTPS).
 */
export function detectProviderGatewayUrl(): string {
  const domain = process.env.OLYMPUS_DOMAIN || '';
  if (domain) {
    return `https://olympus.${domain}/api/provider/v1`;
  }
  return `http://${detectPublicHost()}:3740/api/provider/v1`;
}
