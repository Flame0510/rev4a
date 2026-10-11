'use strict';

const net = require('node:net');

/** Name of the internal header server.js sets and the login route reads. */
const CLIENT_IP_HEADER = 'x-rev4a-client-ip';

/** `::ffff:1.2.3.4` -> `1.2.3.4`; lower-cases IPv6; strips a zone id. Returns '' when it is not an IP. */
function normaliseIp(value) {
  if (typeof value !== 'string') return '';
  let ip = value.trim();
  if (!ip) return '';
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (!net.isIP(ip)) return '';
  return ip.includes(':') ? ip.toLowerCase() : ip;
}

/** True for 127/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7 and fe80::/10. */
function isPrivateOrLoopback(value) {
  const ip = normaliseIp(value);
  if (!ip) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ip === '::1') return true;
  const first = ip.split(':')[0];
  if (!first) return false; // starts with "::" and is not ::1
  const hextet = parseInt(first, 16);
  return (hextet & 0xfe00) === 0xfc00 || (hextet & 0xffc0) === 0xfe80;
}

/** True for 127.0.0.0/8 and ::1 (IPv4-mapped forms are normalised first). */
function isLoopback(value) {
  const ip = normaliseIp(value);
  if (!ip) return false;
  return net.isIPv4(ip) ? ip.startsWith('127.') : ip === '::1';
}

/**
 * Parses REV4A_TRUSTED_PROXIES: comma-separated IPs or CIDRs (IPv4 and IPv6) whose
 * X-Forwarded-For is trusted. Nothing is trusted by default, loopback included. Returns a matcher `(ip) => boolean` with
 * `.invalid` (the entries that were ignored), `.wide` (accepted CIDRs shorter than /8 IPv4 or /16 IPv6) and `.size` (the entries accepted). Pure: no logging.
 */
function parseTrustedProxies(text) {
  const list = new net.BlockList();
  const invalid = [];
  const wide = [];
  let size = 0;
  for (const raw of typeof text === 'string' ? text.split(',') : []) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    const ip = normaliseIp(slash === -1 ? entry : entry.slice(0, slash));
    const prefixText = slash === -1 ? '' : entry.slice(slash + 1);
    const family = ip.includes(':') ? 'ipv6' : 'ipv4';
    const max = family === 'ipv6' ? 128 : 32;
    const prefix = Number(prefixText);
    const prefixOk = slash === -1 || (/^\d{1,3}$/.test(prefixText) && prefix >= 0 && prefix <= max);
    if (!ip || !prefixOk) {
      invalid.push(entry);
      continue;
    }
    if (slash === -1) list.addAddress(ip, family);
    else {
      list.addSubnet(ip, prefix, family);
      if (prefix < (family === 'ipv6' ? 16 : 8)) wide.push(entry);
    }
    size++;
  }
  const matcher = (value) => {
    const ip = normaliseIp(value);
    if (!ip) return false;
    return list.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4');
  };
  matcher.invalid = invalid;
  matcher.size = size;
  matcher.wide = wide;
  return matcher;
}

/** Expands an IPv6 address (already normalised) to its 8 hextets as numbers. */
function ipv6Hextets(ip) {
  let text = ip;
  const dot = text.lastIndexOf(':') + 1;
  if (text.includes('.')) {
    const [a, b, c, d] = text.slice(dot).split('.').map(Number);
    text = text.slice(0, dot) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x, 16));
}

/**
 * The key login attempts are counted against: IPv4 as is, IPv6 reduced to its /64 prefix
 * (`2001:db8:1:2::/64`), since one host or site controls a whole /64.
 */
function throttleKey(ip) {
  if (!ip.includes(':')) return ip;
  const prefix = ipv6Hextets(ip).slice(0, 4);
  while (prefix.length && prefix[prefix.length - 1] === 0) prefix.pop();
  return prefix.map((x) => x.toString(16)).join(':') + '::/64';
}

/**
 * The key login attempts are counted against (see throttleKey). The socket peer is the only
 * trusted value. Only when the peer matches `trusted` (from parseTrustedProxies; with none given
 * no peer matches, loopback included) is the rightmost X-Forwarded-For entry, the one that proxy
 * appended, used instead. Any other peer, private or loopback, is the key itself. An invalid
 * entry falls back to the peer. Returns 'unknown' when nothing usable exists.
 */
function clientAddress(remoteAddress, xffHeader, trusted) {
  const peer = normaliseIp(remoteAddress);
  const peerTrusted = peer && typeof trusted === 'function' && trusted(peer);
  if (peerTrusted && typeof xffHeader === 'string' && xffHeader.trim()) {
    const parts = xffHeader.split(',');
    const forwarded = normaliseIp(parts[parts.length - 1]);
    if (forwarded) return throttleKey(forwarded);
  }
  return peer ? throttleKey(peer) : 'unknown';
}

module.exports = {
  CLIENT_IP_HEADER, clientAddress, isLoopback, isPrivateOrLoopback, normaliseIp, parseTrustedProxies, throttleKey,
};
