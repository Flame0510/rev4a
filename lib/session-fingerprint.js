'use strict';

const { createHmac, createHash, timingSafeEqual } = require('node:crypto');

/** Bind a browser session to the effective password without putting the password in the JWT. */
function passwordFingerprint(password, jwtSecret) {
  return createHmac('sha256', jwtSecret)
    .update('rev4a:session-password:v1\0', 'utf8')
    .update(password, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

/** Hash to fixed-size buffers before the constant-time comparison, including malformed claims. */
function fingerprintEquals(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !expected) return false;
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

module.exports = { passwordFingerprint, fingerprintEquals };
