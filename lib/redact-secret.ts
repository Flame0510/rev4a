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

/** Summarize config failures whose message and command output may contain credentials. */
export function configErrorSummary(e: unknown): string {
  try {
    const err = e as { name?: unknown; status?: unknown; code?: unknown; message?: unknown } | null | undefined;
    // Each field is read once: a getter cannot pass the check and then return something else.
    const name = err?.name;
    const status = err?.status;
    const code = err?.code;
    const kind = typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : 'Error';
    const exit = Number.isSafeInteger(status) ? status : Number.isSafeInteger(code) ? code : undefined;
    if (exit !== undefined) return `${kind} (exit ${exit})`;
    const cause = dockerExecCause(err?.message);
    return cause ? `${kind} (${cause})` : kind;
  } catch {
    return 'Error';
  }
}

/**
 * The cause of a lib/docker-exec.ts failure, from the fixed prefix of its message only
 * (`docker exec <c>: exit 2 — <stderr>` → `exit 2`). The stderr after it is never returned.
 */
function dockerExecCause(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const m = /^docker exec (?:\S+: )?(?:exit (-?\d{1,4})\b|exited with code (-?\d{1,4})\b|(timed out)\b|output (exceeded) \d+ bytes)/.exec(message);
  if (!m) return message === 'Docker is not available' ? 'Docker not available' : null;
  if (m[1] ?? m[2]) return `exit ${m[1] ?? m[2]}`;
  return m[3] ? 'timed out' : 'output too large';
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
