/**
 * MongoDB credential: the steps around the standard native delivery (native.ts).
 *
 * A MongoDB switch-on does more than a store entry: it installs `mongosh` in the agent, makes
 * sure Rev4a's shared skill `rev4a-mongodb` is on the host, writes the store entry and the skill
 * entry (native.ts runEnable), and then asks OpenClaw whether the skill is really eligible.
 * Everything here takes the exec primitives (and the skill deployer) as arguments, so a test
 * runs it without Docker. Imports only native.ts.
 *
 * The connection string holds a password: it never reaches argv or a shell script (the store
 * write sends it on stdin), and every error text built from command output goes through
 * {@link redact} with the secret values.
 */

import { assertDeliverable, redact, runDisable, runEnable, type NativeExec } from './native';

/** The only mongosh release Rev4a installs. A different installed version is replaced by this one. */
export const MONGOSH_VERSION = '2.13.0';
export const MONGODB_PROVIDER_ID = 'mongodb';
export const MONGODB_SKILL = 'rev4a-mongodb';

/** `npm install -g --prefix` target. `/root` is the agent's persistent volume, so mongosh survives a recreate. */
export const MONGOSH_PREFIX = '/root/.local';
export const MONGOSH_BIN = `${MONGOSH_PREFIX}/bin/mongosh`;
export const MONGOSH_PACKAGE_JSON = `${MONGOSH_PREFIX}/lib/node_modules/mongosh/package.json`;

/** The install can take minutes on a slow host or under emulation. */
export const MONGOSH_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** `openclaw skills info` took 7 s on a Mac. */
export const SKILL_INFO_TIMEOUT_MS = 60_000;

/**
 * Prints the installed package.json, but only when the launcher is executable (a package.json
 * with no `bin/mongosh` is a broken install: it is installed again). Constant text, nothing
 * variable in it; always exits 0 so "absent" is an empty answer, not an error.
 */
export const MONGOSH_CHECK_ARGV: readonly string[] = [
  'sh', '-c', `if [ -x ${MONGOSH_BIN} ]; then cat ${MONGOSH_PACKAGE_JSON} 2>/dev/null; fi; exit 0`,
];

/** The pinned install, as an argv array: no shell, nothing interpolated. */
export const MONGOSH_INSTALL_ARGV: readonly string[] = [
  'npm', 'install', '-g', '--prefix', MONGOSH_PREFIX, '--no-fund', '--no-audit', `mongosh@${MONGOSH_VERSION}`,
];

export const SKILL_INFO_ARGV: readonly string[] = ['openclaw', 'skills', 'info', MONGODB_SKILL, '--json'];

/** The `version` of the package.json text {@link MONGOSH_CHECK_ARGV} printed, or '' (absent, empty, unparseable). */
export function parseMongoshVersion(text: string): string {
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

export interface SkillInfo {
  eligible: boolean;
  /** Everything OpenClaw reports as missing (bins, env, config…), flattened to names. */
  missing: string[];
  /** Whether the model is shown the skill; undefined when the output does not say. */
  modelVisible?: boolean;
}

/**
 * Read `openclaw skills info <name> --json`. The JSON may follow a banner line, so it is looked
 * for from the first line that starts with `{`. null when no object with a boolean `eligible`
 * can be read: the caller treats that as "could not read the skill state", never as eligible.
 */
export function parseSkillInfo(text: string): SkillInfo | null {
  const candidates: string[] = [text.trim()];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('{')) candidates.push(lines.slice(i).join('\n').trim());
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    let v: unknown;
    try { v = JSON.parse(c); } catch { continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as { eligible?: unknown; modelVisible?: unknown; missing?: unknown };
    if (typeof o.eligible !== 'boolean') continue;
    const missing: string[] = [];
    if (Array.isArray(o.missing)) {
      for (const x of o.missing) missing.push(String(x));
    } else if (o.missing && typeof o.missing === 'object') {
      for (const list of Object.values(o.missing as Record<string, unknown>)) {
        if (Array.isArray(list)) for (const x of list) missing.push(String(x));
      }
    }
    return {
      eligible: o.eligible,
      missing,
      ...(typeof o.modelVisible === 'boolean' ? { modelVisible: o.modelVisible } : {}),
    };
  }
  return null;
}

/** docker-exec.ts words a deadline as "timed out" (host-side kill or the in-container `timeout`). */
const isTimeout = (message: string): boolean => /timed out/i.test(message);

const lastLines = (text: string, n: number): string =>
  text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ');

async function installedVersion(exec: NativeExec): Promise<string> {
  try {
    return parseMongoshVersion(await exec.run([...MONGOSH_CHECK_ARGV]));
  } catch {
    return '';
  }
}

/**
 * Make sure the pinned mongosh is in the agent. Skipped when `package.json` says
 * {@link MONGOSH_VERSION} and the launcher is executable. A different version (say 2.12.0, put
 * there by the user) or a package.json without the launcher counts as not installed: the pinned
 * version is installed over it. `docker exec` resolves, not rejects, in some timeout cases, so
 * the result is checked again after the install rather than trusted from the exit.
 */
export async function ensureMongosh(exec: NativeExec): Promise<'present' | 'installed'> {
  if ((await installedVersion(exec)) === MONGOSH_VERSION) return 'present';
  let output = '';
  try {
    output = await exec.run([...MONGOSH_INSTALL_ARGV], undefined, { timeoutMs: MONGOSH_INSTALL_TIMEOUT_MS });
  } catch (e) {
    const msg = (e as Error).message;
    const cause = isTimeout(msg) ? 'timed out: ' : '';
    throw new Error(`Could not install mongosh: ${cause}${lastLines(msg, 3)}`);
  }
  if ((await installedVersion(exec)) !== MONGOSH_VERSION) {
    const tail = lastLines(output, 3);
    throw new Error(`Could not install mongosh: the install did not finish${tail ? ` (${tail})` : ''}`);
  }
  return 'installed';
}

export interface MongodbDeps {
  /** Put the shared skill on the host (lib/rev4a-skills.ts). Throws on failure. */
  ensureSkill: (name: string) => Promise<void>;
  /** For the modelVisible warning. */
  warn?: (message: string) => void;
}

/**
 * Switch MongoDB on for one agent, in this order, stopping at the first failure:
 * 1. the version floor (nothing written on an older agent);
 * 2. mongosh in the agent (a failure writes nothing else);
 * 3. the shared skill on the host;
 * 4. the store entry, the skill entry and the reload (runEnable);
 * 5. `openclaw skills info`: not eligible (or a non-zero exit, or unreadable output) fails the
 *    switch-on and rolls back the store entry and the skill entry with the switch-off steps, so
 *    nothing half-on stays. A check that TIMED OUT fails the switch-on too but rolls nothing
 *    back: it says nothing about the skill, and this same path runs for a re-apply after a start
 *    and for an edited secret, where removing the entries would switch off a working credential
 *    because a slow host did not answer in time. The error asks for a retry.
 * mongosh itself stays installed on a rollback and on a switch-off.
 */
export async function enableMongodb(exec: NativeExec, secret: Record<string, string>, deps: MongodbDeps): Promise<void> {
  const values = Object.values(secret).map((v) => v ?? '');
  await assertDeliverable(exec, MONGODB_PROVIDER_ID);
  try {
    await ensureMongosh(exec);
    await deps.ensureSkill(MONGODB_SKILL);
  } catch (e) {
    throw new Error(redact((e as Error).message, values));
  }
  await runEnable(exec, MONGODB_PROVIDER_ID, secret);

  let failure = '';
  try {
    const info = parseSkillInfo(await exec.run([...SKILL_INFO_ARGV], undefined, { timeoutMs: SKILL_INFO_TIMEOUT_MS }));
    if (!info) {
      failure = 'Switched on, but OpenClaw does not load the MongoDB skill: could not read the skill state';
    } else if (!info.eligible) {
      failure = `Switched on, but OpenClaw does not load the MongoDB skill: ${info.missing.length ? `missing ${info.missing.join(', ')}` : 'it is not eligible'}`;
    } else if (info.modelVisible === false) {
      (deps.warn ?? console.warn)('[credentials] the rev4a-mongodb skill is eligible but not shown to the model');
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (isTimeout(msg)) {
      throw new Error('Switched on, but checking that OpenClaw loads the MongoDB skill timed out: retry the switch-on');
    }
    failure = `Switched on, but OpenClaw does not load the MongoDB skill: could not read the skill state (${lastLines(redact(msg, values), 2)})`;
  }
  if (!failure) return;
  const rollback = await runDisable(exec, MONGODB_PROVIDER_ID, values);
  throw new Error(redact(rollback.length ? `${failure}. Undoing it also failed: ${rollback.join('; ')}` : failure, values));
}
