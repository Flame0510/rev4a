import { networkInterfaces } from 'os';

/**
 * Detect the host's best public-facing IPv4 address for agent URLs.
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
 * containers. Agents reach Olympus through the Docker host gateway
 * (host.docker.internal), injected at container creation via --add-host.
 */
export function detectProviderGatewayUrl(): string {
  return 'http://host.docker.internal:3740/api/provider/v1';
}
