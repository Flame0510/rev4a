import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { dockerExec, dockerExecWithInput } from './docker-exec';
import { redactedMessage } from './redact-secret';

const execFileAsync = promisify(execFile);

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

type CopyIn = (source: string, destination: string) => Promise<void>;
/** Tar stream of `docker cp <container>:<path> -`, or null when the path does not exist. */
type CopyOut = (source: string) => Promise<Buffer | null>;

const dockerCopyIn: CopyIn = async (source, destination) => {
  await execFileAsync('docker', ['cp', source, destination], { timeout: 15_000 });
};

const dockerCopyOut: CopyOut = async (source) => {
  try {
    const { stdout } = await execFileAsync('docker', ['cp', source, '-'], { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout as Buffer;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    if (/Could not find the file/i.test(`${err.stderr ?? ''} ${err.message ?? ''}`)) return null;
    throw e;
  }
};

export type StoppedTokenEntry = { kind: 'absent' } | { kind: 'file'; token: string } | { kind: 'other' };

/**
 * What sits at /root/.agent-token in a container that is not running, read with `docker cp … -`
 * (a tar stream; `docker exec` cannot reach a stopped container). A directory or a symlink there is
 * `other`: copying onto it would land elsewhere (into the directory, or through the link) while the
 * entrypoint keeps the old token. The token itself stays in memory: never logged or returned to a client.
 */
export async function readStoppedTokenEntry(container: string, copyOut: CopyOut = dockerCopyOut): Promise<StoppedTokenEntry> {
  const tar = await copyOut(`${container}:/root/.agent-token`);
  if (!tar) return { kind: 'absent' };
  let offset = 0;
  // Docker's archive writer may put PAX or GNU long-name records before the entry itself: skip them.
  for (let records = 0; records < 8; records += 1) {
    if (offset + 512 > tar.length) break;
    const type = String.fromCharCode(tar[offset + 156]);
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) break;
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type !== '0' && type !== '\0') return { kind: 'other' };
    return { kind: 'file', token: tar.subarray(offset + 512, offset + 512 + size).toString('utf8').split('\n')[0].trim() };
  }
  throw new Error('Unreadable /root/.agent-token entry');
}

/**
 * Stores the gateway token in a container that is not running, where `docker exec` cannot reach.
 * The file lands on the agent's volume (`/root`), and the entrypoint reads it at the next start
 * before OPENCLAW_GATEWAY_TOKEN. This matters: the file survives Recreate, so an agent that kept an
 * old file would keep the old token even after a Recreate. The token is staged on the host in a
 * private temporary directory (0700, file 0600), copied with `docker cp` (never in argv), and the
 * staging directory is removed whatever happens.
 */
export async function writeTokenToStoppedContainer(
  container: string,
  token: string,
  copy: CopyIn = dockerCopyIn,
  copyOut: CopyOut = dockerCopyOut,
): Promise<void> {
  if ((await readStoppedTokenEntry(container, copyOut)).kind === 'other') {
    throw new Error('/root/.agent-token is not a regular file in this agent: fix it by hand, then save again');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-token-'));
  try {
    fs.chmodSync(dir, 0o700);
    const staged = path.join(dir, '.agent-token');
    fs.writeFileSync(staged, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(staged, 0o600);
    await copy(staged, `${container}:/root/.agent-token`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface StoppedAgentRef {
  name: string;
  agentId: string;
}

export interface RepairDeps {
  /** Current state and OPENCLAW_GATEWAY_TOKEN (verbatim, '' when unset) of one container. */
  inspect: (name: string) => Promise<{ state: string; envToken: string }>;
  /** True while a long operation owns the agent (update, recreate, restore, edit, backup). */
  isBusy: (agentId: string) => Promise<boolean>;
  copy?: CopyIn;
  copyOut?: CopyOut;
  warn?: (message: string) => void;
}

/**
 * Startup repair for installs hit by the pre-1.30.1 Save & Sync, which skipped stopped agents: every
 * agent that is not running and whose effective token (the volume file, else its environment, as the
 * entrypoint decides) differs from the saved shared token gets the saved one on its volume, read at its
 * next start. Each agent is inspected and checked for a running operation right before it is touched,
 * and handled on its own: one that started, became busy or disappeared is skipped (the next Rev4a start
 * looks again) and never stops the others. Agents already on the token are left alone (idempotent); a
 * directory or symlink in place of the file is reported and never followed. Resolves to the repaired names.
 */
export async function repairStoppedAgentTokens(
  current: string,
  list: () => Promise<StoppedAgentRef[]>,
  deps: RepairDeps,
): Promise<string[]> {
  if (!current) return [];
  const repaired: string[] = [];
  for (const agent of await list()) {
    try {
      if (agent.agentId && await deps.isBusy(agent.agentId)) continue;
      const { state, envToken } = await deps.inspect(agent.name);
      if (state !== 'exited' && state !== 'created') continue;
      const entry = await readStoppedTokenEntry(agent.name, deps.copyOut);
      if (entry.kind === 'other') {
        deps.warn?.(`${agent.name}: /root/.agent-token is not a regular file; its token was not repaired`);
        continue;
      }
      const effective = entry.kind === 'file' ? entry.token : envToken;
      if (effective === current) continue;
      await writeTokenToStoppedContainer(agent.name, current, deps.copy, deps.copyOut);
      repaired.push(agent.name);
    } catch (e) {
      deps.warn?.(`${agent.name}: token repair skipped: ${redactedMessage(e, current)}`);
    }
  }
  return repaired;
}

/** A token the entrypoint can carry intact: non-empty, at most 4096 characters, no whitespace or controls. */
export function isValidAgentsToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value);
}
