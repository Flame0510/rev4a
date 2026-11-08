'use strict';

const SKILL_PROMOTE_MAX_FILE_BYTES = 1024 * 1024;
const SKILL_PROMOTE_MAX_EXTRA_FILES = 200;

/** Container listings are untrusted: accept only one plain filename, measured in UTF-8 bytes. */
function isSafeSkillPromoteName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !/[/\\\0\r\n]/.test(name) && Buffer.byteLength(name, 'utf8') <= 255;
}

module.exports = { isSafeSkillPromoteName, SKILL_PROMOTE_MAX_FILE_BYTES, SKILL_PROMOTE_MAX_EXTRA_FILES };
