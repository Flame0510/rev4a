/**
 * Removes a secret from text that is about to be returned to a client or logged.
 *
 * Replaces every occurrence of `secret` (when it is non-empty) and the value of any
 * `OPENCLAW_GATEWAY_TOKEN=<value>` assignment with `***`, so an error built from a command
 * line or an environment dump cannot leak the gateway token.
 */
export function redactSecret(text: string, secret?: string | null): string {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('***');
  return out.replace(/(OPENCLAW_GATEWAY_TOKEN=)[^\s'"]+/g, '$1***');
}

/** The message of an unknown thrown value, with the secret removed. */
export function redactedMessage(e: unknown, secret?: string | null): string {
  const message = e instanceof Error ? e.message : String(e);
  return redactSecret(message, secret);
}
