/**
 * Who may call the Rev4a Provider Gateway.
 *
 * Agents present a token derived from the `rev4a` entry of provider-keys.json.
 * Its authenticated id takes precedence over any caller-supplied header.
 * The shared key and REV4A_API_KEY remain accepted for legacy callers, whose
 * metering identity still comes from the compatibility header.
 *
 * **Why this is its own module.** The two v1 routes each carried their own copy
 * of the check and the copies had drifted — one guarded the empty token, the
 * other did not. Worse, both compared the incoming token against *every* value
 * in `provider-keys.json`:
 *
 *     Object.values(providerKeys).some((key) => token === key)
 *
 * `provider-keys.json` holds two different kinds of secret in one map. The
 * `rev4a` entry is the password to this door. Every other entry is a credential
 * Rev4a presents to an upstream provider. Iterating the map conflated them, so a
 * DeepSeek API key authenticated here exactly like the gateway key — verified
 * against a running instance, which answered `400 invalid_request_error` to a
 * malformed body rather than `401`.
 *
 * With one upstream provider configured that granted nothing: the holder of a
 * DeepSeek key can already spend at DeepSeek. It mattered as a latent fault. Add
 * an OpenAI key and the old DeepSeek key silently becomes a way to spend at
 * OpenAI, with nothing in the code or the UI to say so.
 */
import { timingSafeEqual } from 'crypto';
import { readProviderKeys } from '@/app/api/gateway/provider/keys';
import { verifyAgentProxyToken } from '@/lib/agent-proxy-token';
import { AGENT_HEADER } from '@/lib/proxy-usage';

export interface GatewayCaller {
  kind: 'agent' | 'legacy';
  /** Authenticated token id, or the untrusted legacy header (resolved before metering). */
  agentId: string | null;
}

/** Compare without leaking length or position through timing. */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself an early exit.
  // Comparing digests of equal length would hide it; for a bearer token the
  // length is not the secret, so a plain guard is enough.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The caller identity when the request carries a gateway credential, else null.
 *
 * Never accepts an absent or empty token, whatever the key file contains: an
 * entry saved as `""` would otherwise match a request with no Authorization
 * header at all.
 */
export function isGatewayClient(request: Request): GatewayCaller | null {
  const token = (request.headers.get('Authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) return null;

  // provider-keys.json is hand-editable: a non-string value must deny, not throw.
  // Buffer.from on a number raises, and the models route has no catch.
  const gatewayKey: unknown = readProviderKeys()['rev4a'];
  const agentId = verifyAgentProxyToken(gatewayKey, token);
  if (agentId !== null) return { kind: 'agent', agentId };
  if (typeof gatewayKey === 'string' && gatewayKey && secretEquals(token, gatewayKey)) {
    return { kind: 'legacy', agentId: request.headers.get(AGENT_HEADER) };
  }

  const masterKey = process.env.REV4A_API_KEY;
  if (masterKey && secretEquals(token, masterKey)) {
    return { kind: 'legacy', agentId: request.headers.get(AGENT_HEADER) };
  }

  return null;
}
