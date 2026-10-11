/** Types for the CommonJS client address helper shared by server.js and the login route. */

export const CLIENT_IP_HEADER: 'x-rev4a-client-ip';
export function normaliseIp(value: unknown): string;
export function isPrivateOrLoopback(value: unknown): boolean;
export function isLoopback(value: unknown): boolean;
/** Matcher for REV4A_TRUSTED_PROXIES entries. `invalid` lists the ignored entries, `size` the accepted ones. */
export interface TrustedProxies {
  (ip: unknown): boolean;
  readonly invalid: string[];
  /** Accepted CIDRs shorter than /8 (IPv4) or /16 (IPv6): any client in them can choose its own key. */
  readonly wide: string[];
  readonly size: number;
}
export function parseTrustedProxies(text: string | undefined | null): TrustedProxies;
/** IPv4 as is; IPv6 reduced to its /64 prefix, e.g. `2001:db8:1:2::/64`. */
export function throttleKey(ip: string): string;
export function clientAddress(
  remoteAddress: string | undefined | null,
  xffHeader: string | undefined | null,
  trusted?: ((ip: string) => boolean) | null,
): string;
