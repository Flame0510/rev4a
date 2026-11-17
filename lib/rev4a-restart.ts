/** Server-only restart planning. Routes run the returned action with Next's after(). */
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import * as os from 'os';

export class RestartUnavailable extends Error {
  constructor() { super('Restart Rev4a by hand to apply'); }
}

export function prepareRestart() : { mode: 'systemd' | 'supervisor'; run: () => void } {
  // An active unit elsewhere on the machine is not evidence that it owns this process.
  // INVOCATION_ID plus our own cgroup ties the request to rev4a.service specifically.
  let inUnit = false;
  if (process.env.INVOCATION_ID) {
    try {
      inUnit = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').some((line) => {
        const cgroup = line.slice(line.lastIndexOf(':') + 1);
        return !/(?:^|\/)user\.slice(?:\/|$)/.test(cgroup) && /(?:^|\/)system\.slice\/rev4a\.service(?:\/|$)/.test(cgroup);
      });
    } catch { /* not Linux/systemd */ }
  }
  const supervised = process.env.REV4A_SUPERVISED === '1';
  // Match the launcher's CONFIG_DIR on every platform, including default Windows installs.
  const flagDirectory = join(process.env.REV4A_DATA_DIR || join(os.homedir(), '.config', 'rev4a'), 'data');
  const flagRestart = () => {
    fs.accessSync(flagDirectory, fs.constants.W_OK);
    fs.writeFileSync(join(flagDirectory, '.restart-flag'), '', { mode: 0o600 });
  };
  if (inUnit) {
    return { mode: 'systemd', run: () => {
      const systemctl = (args: string[]) => process.getuid?.() === 0
        ? execFileSync('systemctl', args, { timeout: 15000, stdio: 'pipe' })
        : execFileSync('sudo', ['-n', 'systemctl', ...args], { timeout: 15000, stdio: 'pipe' });
      // Keep restart available even if reloading the unit is refused.
      try { systemctl(['daemon-reload']); }
      catch { console.warn('[restart] systemd daemon-reload failed; attempting restart'); }
      // --no-block returns once the job is queued: systemctl itself runs inside this unit, so a
      // blocking call would be killed by the very stop it asked for and look like a failure
      // (writing the flag then caused a second restart after the first one). Timeouts also carry a signal.
      try { systemctl(['restart', '--no-block', 'rev4a.service']); }
      catch (error) {
        const failure = error as { code?: string; timedOut?: boolean; signal?: string | null };
        if (failure?.signal && failure.code !== 'ETIMEDOUT' && !failure.timedOut) return;
        console.error('[restart] systemd restart failed');
        if (!supervised) throw error;
        flagRestart();
        console.warn('[restart] requested supervisor restart instead');
      }
    } };
  }
  if (supervised) {
    // The CLI calls the config root CONFIG_DIR and its data/ child DATA_DIR.
    // Match serve()'s existing watcher and CLI restart, rather than creating an unwatched flag.
    fs.accessSync(flagDirectory, fs.constants.W_OK);
    return { mode: 'supervisor', run: flagRestart };
  }
  throw new RestartUnavailable();
}
