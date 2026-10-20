/**
 * The keys GET /api/envcheck reports on, and how each one is described. The list is fixed
 * on purpose: the endpoint is a diagnostic, not a dump of the process environment, so it
 * only ever answers about these keys. Secrets are reported as set / not set only — never a
 * prefix or any other part of their value. No imports here: the route and the test script
 * both load this file directly.
 */

/** The keys the endpoint answers about, in the order the response lists them. */
// Frozen: the lists are the endpoint's whole contract, so no importer can widen them at runtime.
export const ENVCHECK_KEYS: readonly string[] = Object.freeze([
  'REV4A_PASSWORD',
  'REV4A_TOKEN',
  'REV4A_JWT_SECRET',
  'REV4A_ALERTS_ENABLED',
  'REV4A_DB',
  'PROVIDER_DEEPSEEK_API_KEY',
  'NODE_ENV',
]);

/** Keys whose value is never returned, not even partially: only set / not set. */
export const SENSITIVE_KEYS: readonly string[] = Object.freeze([
  'REV4A_PASSWORD',
  'REV4A_TOKEN',
  'REV4A_JWT_SECRET',
  'PROVIDER_DEEPSEEK_API_KEY',
]);

/**
 * Describe the fixed list of keys. A sensitive key answers exactly "set" when it holds a
 * non-empty string, "not set" otherwise. Any other key returns its value, or "(not set)"
 * when it is missing or empty. Keys outside ENVCHECK_KEYS are never in the result.
 */
export function describeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ENVCHECK_KEYS) {
    const value = env[key];
    if (SENSITIVE_KEYS.includes(key)) {
      result[key] = typeof value === 'string' && value.length > 0 ? 'set' : 'not set';
    } else {
      result[key] = typeof value === 'string' && value.length > 0 ? value : '(not set)';
    }
  }
  return result;
}
