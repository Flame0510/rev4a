import { dockerExec, dockerExecWithInput } from './docker-exec';

/**
 * Constant script that stores the gateway token inside an agent container. The token travels on
 * stdin: this write never puts it in argv (host or container). The gateway process itself receives it in
 * OPENCLAW_GATEWAY_TOKEN from the image entrypoint (agent-templates/base-image/entrypoint.sh),
 * not as `--token`, unless openclaw.json sets its own gateway.auth (older images: `--token`). The file is written 0600 and swapped in
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

/**
 * Constant script that removes the group and other permissions of an existing token file
 * (agents created before the file was written 0600 may have it 0644 → 0600). It only ever
 * removes bits: a stricter mode such as 0400 is left alone. Prints "changed" only when it
 * changed the mode; a missing file or a symlink is left alone. Idempotent.
 */
export const TOKEN_MODE_REPAIR_SCRIPT =
  'f=/root/.agent-token; if [ -f "$f" ] && [ ! -L "$f" ]; then m=$(stat -c %a "$f"); '
  + 'case "$m" in *00) ;; *) chmod go-rwx "$f" && echo changed ;; esac; fi; true';

/** Runs the repair in one container; true when it changed the mode. */
export async function repairTokenFileMode(
  container: string,
  exec: (container: string, argv: string[], opts?: { timeoutMs?: number }) => Promise<string> = dockerExec,
): Promise<boolean> {
  const out = await exec(container, ['sh', '-c', TOKEN_MODE_REPAIR_SCRIPT], { timeoutMs: 10_000 });
  return out.trim() === 'changed';
}

/** Repairs the token file mode of every running agent container; resolves to how many changed. */
export async function repairAllTokenFileModes(
  list: () => Promise<string[]>,
  exec?: Parameters<typeof repairTokenFileMode>[1],
): Promise<number> {
  let changed = 0;
  for (const name of await list()) {
    try {
      if (await repairTokenFileMode(name, exec)) changed += 1;
    } catch {
      // A container that stopped meanwhile: fixed at the next start.
    }
  }
  return changed;
}
