/**
 * Runs the OpenClaw CLI against an agent's own Gateway with the token the Gateway really
 * runs with.
 *
 * The entrypoint (agent-templates/base-image/entrypoint.sh) resolves the token as
 * `/root/.agent-token` first, then the container's OPENCLAW_GATEWAY_TOKEN, then a random one,
 * and starts the Gateway with it. `/api/agents/token` rotates a token by rewriting the file only,
 * so the container env keeps the OLD value and a CLI that reads the env is refused with
 * "gateway token mismatch". Callers include config patches, secret-store writes and reloads,
 * GitHub identity RPCs, Telegram pairing, device management and browser links, cron operations,
 * subscription models and usage, and update checks. The token is read inside the container and
 * never reaches host argv, logs or script text.
 *
 * daemon.js (plain CommonJS, cannot import this file) keeps its own copy of the same text:
 * COSTS_GATEWAY_CLI. Keep the two identical.
 */

/** Exports the file token when present. Same precedence as the entrypoint; no output. */
export const GATEWAY_TOKEN_SNIPPET =
  'if [ -f /root/.agent-token ]; then OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]"); export OPENCLAW_GATEWAY_TOKEN; fi';

/**
 * The `sh -c` script for `openclaw "$@"`. With a port it also pins OPENCLAW_GATEWAY_PORT
 * (Rev4a agents listen on 3000, not OpenClaw's default); with `port: null` it leaves the
 * Gateway address to the caller (an OPENCLAW_GATEWAY_URL in the exec environment).
 */
export function gatewayCliScript(port: number | null = 3000): string {
  const parts: string[] = [];
  if (port !== null) parts.push(`export OPENCLAW_GATEWAY_PORT=${Math.trunc(port)}`);
  parts.push(GATEWAY_TOKEN_SNIPPET, 'exec openclaw "$@"');
  return parts.join('; ');
}

/**
 * Wraps the arguments that follow `openclaw` into `sh -c <script> sh <args…>`. Arguments stay
 * positional: nothing a caller passes is interpolated into the script.
 */
export function gatewayCliArgv(args: readonly string[], opts: { port?: number | null } = {}): string[] {
  const port = opts.port === undefined ? 3000 : opts.port;
  return ['sh', '-c', gatewayCliScript(port), 'sh', ...args];
}

/**
 * For a shell script that calls `openclaw` itself (several commands, a pipeline): the same
 * token resolution first, then the script. The script is Rev4a's own text, never user input.
 */
export function gatewayShellScript(script: string): string {
  return `${GATEWAY_TOKEN_SNIPPET}; ${script}`;
}
