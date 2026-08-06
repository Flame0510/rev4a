import { networkInterfaces } from 'os';

/**
 * Detect the host's best public-facing IPv4 address for agent URLs.
 *
 * Priority:
 *   1. External IP detection via icanhazip.com (works from Docker containers)
 *   2. Hostname resolution (filters out 172.x Docker internal IPs)
 *   3. First non-internal IPv4 network interface
 *   4. 'localhost' fallback
 */
export function detectPublicHost(): string {
  // 1. External detection (works from inside Docker containers)
  try {
    const { execSync } = require('child_process');
    const ip = execSync(
      'curl -fs --max-time 3 icanhazip.com 2>/dev/null || curl -fs --max-time 3 ifconfig.me 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('172.')) {
      return ip;
    }
  } catch { /* ignore */ }

  // 2. Hostname (often gives public IP on VPS, but Docker internal 172.x is filtered)
  try {
    const { execSync } = require('child_process');
    const hostname = execSync('hostname -I 2>/dev/null || hostname 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).trim().split(/\s+/)[0];
    if (hostname && hostname !== '127.0.0.1' && hostname !== '::1' && !hostname.startsWith('172.')) {
      return hostname;
    }
  } catch { /* ignore */ }

  // 3. Network interfaces (bare metal)
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

  // 4. Fallback
  return 'localhost';
}

/**
 * Build the provider gateway base URL used to sync model config into agent
 * containers. Agents reach Rev4a through the Docker host gateway
 * (host.docker.internal), injected at container creation via --add-host.
 */
export function detectProviderGatewayUrl(): string {
  return 'http://host.docker.internal:3740/api/provider/v1';
}
