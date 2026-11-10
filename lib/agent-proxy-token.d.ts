/** Pure, stateless credentials derived from the shared Rev4a gateway key. */
export function deriveAgentProxyToken(sharedKey: string, agentId: string): string;
/** Invalid credentials (including an empty key) return null. */
export function verifyAgentProxyToken(sharedKey: unknown, token: unknown): string | null;
