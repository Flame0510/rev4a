import { isSecretName } from './update-state.js';

/** Shorter secrets are not matched as plain text (see redactSecret). */
const MIN_SECRET_LENGTH = 8;

/**
 * Removes a secret from text that is about to be returned to a client or logged.
 *
 * Replaces every occurrence of `secret` (when it is non-empty) and the value of any
 * `OPENCLAW_GATEWAY_TOKEN=<value>` assignment with `***`, so an error built from a command
 * line or an environment dump cannot leak the gateway token.
 */
export function redactSecret(text: string, secret?: string | null): string {
  let out = String(text ?? '');
  // A very short secret would also match ordinary words: only the assignment pattern applies then.
  if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('***');
  return out.replace(/(OPENCLAW_GATEWAY_TOKEN=)[^\s'"]+/g, '$1***');
}

/** The message of an unknown thrown value, with the secret removed. */
export function redactedMessage(e: unknown, secret?: string | null): string {
  const message = e instanceof Error ? e.message : String(e);
  return redactSecret(message, secret);
}
/**
 * Redact JSON by key and credential location, without mutating it. Private
 * containers retain their names/shape, but every leaf (including array members)
 * is masked regardless of its name, type or length. Used by config inspection.
 */
export function redactConfigSecrets(value: unknown, path: string[] = [], privateValues = false): unknown {
  const privateLocation = privateValues || path.at(-1)?.toLowerCase() === 'env'
    || path.at(-1)?.toLowerCase() === 'headers'
    || (path.some(part => part.toLowerCase() === 'tls') && ['ca', 'cert'].includes(path.at(-1)?.toLowerCase() ?? ''));
  if (Array.isArray(value)) return value.map((item) => redactConfigSecrets(item, path, privateLocation));
  if (value === null || typeof value !== 'object') return privateLocation ? '***' : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    // Only known non-credential metadata in gateway.auth stays readable.
    const authSection = path.length === 1 && path[0] === 'gateway' && key === 'auth'
      && child !== null && typeof child === 'object' && !Array.isArray(child);
    const publicAuthMetadata = (key === 'mode' && typeof child === 'string'
      && ['none', 'token', 'password', 'trusted-proxy'].includes(child))
      || (key === 'allowTailscale' && typeof child === 'boolean');
    const gatewayAuthValue = path.length === 2 && path[0] === 'gateway' && path[1] === 'auth'
      && !publicAuthMetadata;
    const normalized = key.replace(/[_.-]/g, '').toLowerCase();
    const secret = (!authSection && isSecretName(key)) || gatewayAuthValue
      || normalized === 'authprofiles' || normalized === 'xrev4aagent'
      || (path[0] === 'channels' && normalized === 'serviceaccount');
    return [key, secret ? '***' : redactConfigSecrets(child, [...path, key], privateLocation)];
  }));
}
