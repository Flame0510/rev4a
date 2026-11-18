import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface ServerAddresses {
  ipv4: string[];
  ipv6: string[];
}

export interface DomainDnsRecord {
  name: string;
  type: 'A' | 'AAAA';
  expected: string[];
  found: string[];
  ok: boolean;
}

export function canonicalIPv6(address: string): string {
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function globalIPv4(address: string): boolean {
  const [a, b, c, d] = address.split('.').map(Number);
  if (a === 192 && b === 0 && c === 0) return d === 9 || d === 10;
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 168 || (b === 0 && c === 2) || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

function globalIPv6(address: string): boolean {
  // 2000::/3 is the global unicast allocation. Exclude documentation and local-use assignments within it.
  return /^[23]/.test(address) && !/^(2001:db8:|2001:2:|2001:(?:1[0-9a-f]|2[0-9a-f]):|3ffe:|3fff:(?:[0-9a-f]{0,3}:))/.test(address);
}

export function serverNetworkInterfaces(): ReturnType<typeof networkInterfaces> {
  try { return networkInterfaces(); } catch { return {}; }
}

export function serverAddresses(interfaces = serverNetworkInterfaces()): ServerAddresses {
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = entry.address.split('%', 1)[0];
      if (isIPv4(address) && globalIPv4(address)) ipv4.add(address);
      if (isIPv6(address)) {
        const canonical = canonicalIPv6(address);
        if (globalIPv6(canonical)) ipv6.add(canonical);
      }
    }
  }
  return { ipv4: [...ipv4].sort(), ipv6: [...ipv6].sort() };
}
