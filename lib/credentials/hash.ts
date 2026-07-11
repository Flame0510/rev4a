import { createHash } from 'crypto';

/**
 * Hash a token for comparison without exposing the raw value in logs/responses.
 * Uses SHA256 — collision-safe, deterministic.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf-8').digest('hex').slice(0, 12);
}
