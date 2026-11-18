'use strict';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Shared by the CLI, DNS endpoint and input. No server dependencies. */
function normalizeDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase();
  const labels = domain.split('.');
  // Leave room for a 40-character agent label and its 5-character dev port suffix.
  if (domain && (domain.length > 207 || labels.length < 2 || !labels.every(label => LABEL.test(label))
    || !/[a-z]/.test(labels.at(-1)) || labels.at(-1) === 'localhost')) {
    throw new Error('REV4A_DOMAIN must be a DNS hostname without a scheme, port, wildcard or trailing dot.');
  }
  return domain;
}

module.exports = { LABEL, normalizeDomain };
