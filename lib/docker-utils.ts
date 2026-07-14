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
