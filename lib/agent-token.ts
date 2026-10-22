import { dockerExecWithInput } from './docker-exec';

/**
 * Constant script that stores the gateway token inside an agent container. The token travels on
 * stdin, never in argv (host or container), and the file is written 0600 and swapped in
 * atomically. The file format is unchanged: one line, the token (read by the entrypoint,
 * lib/agent-devices.ts and lib/gateway-cli.ts).
 */
export const TOKEN_WRITE_ARGV = [
  'sh',
  '-c',
  // A directory in the way is refused (mv would silently move the file into it), and a stale tmp
  // is removed first so the umask applies to a freshly created file.
  'umask 077; if [ -d /root/.agent-token ]; then echo "/root/.agent-token is a directory" >&2; exit 1; fi; '
    + 'rm -f /root/.agent-token.tmp; cat > /root/.agent-token.tmp && mv -f /root/.agent-token.tmp /root/.agent-token',
];

type ExecWithInput = (container: string, argv: string[], input: string, opts?: { timeoutMs?: number }) => Promise<string>;

export async function writeTokenToContainer(
  container: string,
  token: string,
  exec: ExecWithInput = dockerExecWithInput,
): Promise<void> {
  await exec(container, TOKEN_WRITE_ARGV, `${token}\n`, { timeoutMs: 10_000 });
}

/** Argv of `docker restart <name>` (no shell involved). */
export function restartArgv(container: string): string[] {
  return ['restart', container];
}
