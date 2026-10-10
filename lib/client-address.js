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

/**
 * The address login attempts are counted against. The socket peer is the only trusted value;
 * when it is a loopback or private address (a reverse proxy on this host or Docker network),
 * the rightmost X-Forwarded-For entry (the one that proxy appended) is used instead. An invalid
 * entry falls back to the peer. Returns 'unknown' when nothing usable exists.
 */
function clientAddress(remoteAddress, xffHeader) {
  const peer = normaliseIp(remoteAddress);
  if (peer && isPrivateOrLoopback(peer) && typeof xffHeader === 'string' && xffHeader.trim()) {
    const parts = xffHeader.split(',');
    const forwarded = normaliseIp(parts[parts.length - 1]);
    if (forwarded) return forwarded;
  }
  return peer || 'unknown';
}

module.exports = { CLIENT_IP_HEADER, clientAddress, isPrivateOrLoopback, normaliseIp };
