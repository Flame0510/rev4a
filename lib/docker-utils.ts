/**
 * Docker-related host helpers.
 *
 * This module used to export `detectPublicHost()`, which shelled out to
 * `curl icanhazip.com` via execSync to discover the machine's public IP, then
 * fell back to `hostname -I` and finally the literal string 'localhost'. It was
 * removed rather than optimised, because the caching it seemed to need would
 * only have made a wrong answer stable:
 *
 *   - execSync blocks the entire event loop, so every call froze the whole
 *     server — not just its own request — for ~270ms, and up to the 5s timeout
 *     when the network hung. Node's own guidance names execSync in a server as
 *     a denial-of-service vector.
 *   - On macOS it never even worked: icanhazip answers with IPv6, which the
 *     IPv4-only validation discarded, and `hostname -I` is a GNU-only flag. The
 *     value that came back was the machine's `.local` mDNS name, reachable only
 *     from the same LAN.
 *   - It answered the wrong question. Callers needed "which URL should this
 *     user's browser open", not "what is this machine's WAN address". Those
 *     differ behind NAT, behind a reverse proxy, and over a tunnel.
 *
 * Agent Control UI links are now built from the host the request reached Rev4a on
 * (`hostnameFromHostHeader()` in `lib/agent-devices.ts`) — a hostname already
 * proven to reach this server, since the dashboard is being served over it.
 */

/**
 * Build the provider gateway base URL used to sync model config into agent
 * containers. Agents reach Rev4a through the Docker host gateway
 * (host.docker.internal), injected at container creation via --add-host.
 */
export function detectProviderGatewayUrl(): string {
  return 'http://host.docker.internal:3740/api/provider/v1';
}
