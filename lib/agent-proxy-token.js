'use strict';

/** Stateless agent credentials, rooted in the existing gateway key. */
const { createHmac, timingSafeEqual } = require('node:crypto');
const { AGENT_ID_RE } = require('./proxy-usage.js');

const DOMAIN = 'rev4a:agent-proxy:v1\0';

function validKey(key) {
  return typeof key === 'string' && key.length > 0;
}

/** Derive the full 32-byte HMAC; never read or write stored state. */
function deriveAgentProxyToken(sharedKey, agentId) {
  if (!validKey(sharedKey)) throw new TypeError('A non-empty gateway key is required');
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) throw new TypeError('Invalid agent id');
  const mac = createHmac('sha256', sharedKey).update(DOMAIN + agentId).digest('base64url');
  return `r4a1.${agentId}.${mac}`;
}

/** Return the authenticated id, or null. The MAC is compared in constant time. */
function verifyAgentProxyToken(sharedKey, token) {
  if (!validKey(sharedKey) || typeof token !== 'string') return null;
  // Agent ids may contain dots: split off only the fixed prefix and final MAC.
  const match = /^r4a1\.(.+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !AGENT_ID_RE.test(match[1])) return null;
  const expected = deriveAgentProxyToken(sharedKey, match[1]);
  // Both strings have the same public format/length; compare canonical base64url too.
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ? match[1] : null;
}

module.exports = { deriveAgentProxyToken, verifyAgentProxyToken };
