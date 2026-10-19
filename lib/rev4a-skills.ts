import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SHARED_SKILLS_DIR } from './rev4a-paths';

/**
 * Rev4a's own shared skills: skills the package ships (`rev4a-skills/<name>/SKILL.md`) and
 * Rev4a puts, once, in the host's shared skills directory. Every agent mounts that directory
 * read-only and already lists it in `skills.load.extraDirs`, so a file written here is seen
 * by the agents live. Nothing is ever copied into a container or an agent's workspace.
 *
 * The `rev4a-` prefix keeps these apart from the skills a user puts in the same directory;
 * only the named skill is written, no other skill is read, changed or removed.
 */

export interface Rev4aSkillDirs {
  /** Directory that holds `<name>/SKILL.md` sources. Default: `<cwd>/rev4a-skills` (the package root). */
  sourceRoot?: string;
  /** Shared skills directory on the host. Default: {@link SHARED_SKILLS_DIR}. */
  targetDir?: string;
}

const SKILL_NAME_RE = /^rev4a-[a-z0-9][a-z0-9-]{0,60}$/;

/**
 * Copy `<sourceRoot>/<name>/SKILL.md` to `<targetDir>/<name>/SKILL.md` when the content
 * differs. Returns `written` or `unchanged`. Throws (with a message free of file contents)
 * when the source is missing or the target cannot be written.
 *
 * The file is written through a temporary name and renamed, so an agent reading the skill
 * mid-update sees the old text or the new one, never a prefix.
 */
export async function ensureRev4aSkill(name: string, dirs: Rev4aSkillDirs = {}): Promise<'written' | 'unchanged'> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid Rev4a skill name: ${name}`);
  const sourceRoot = dirs.sourceRoot ?? path.join(process.cwd(), 'rev4a-skills');
  const targetDir = dirs.targetDir ?? SHARED_SKILLS_DIR;
  const source = path.join(sourceRoot, name, 'SKILL.md');
  let content: string;
  try {
    content = await fs.readFile(source, 'utf-8');
  } catch {
    throw new Error(`The ${name} skill file is missing from this Rev4a install (${source})`);
  }
  const dir = path.join(targetDir, name);
  const target = path.join(dir, 'SKILL.md');
  try {
    if ((await fs.readFile(target, 'utf-8')) === content) return 'unchanged';
  } catch { /* absent or unreadable: write it */ }
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    // Unique per call: two switch-ons in one process deploy at the same time.
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o644 });
    await fs.rename(tmp, target);
  } catch (e) {
    throw new Error(`Could not write the ${name} skill to ${dir}: ${(e as Error).message}`);
  }
  return 'written';
}

/**
 * True for the skills Rev4a ships and manages (`rev4a-*`). The Skills routes treat them as
 * read-only: the next start or switch-on would overwrite an edit, and deleting one breaks the
 * credential that depends on it.
 */
export function isRev4aOwnedSkill(name: string): boolean {
  // Case-insensitive: on a case-insensitive filesystem (macOS) Rev4a-x is the same directory as rev4a-x.
  return /^rev4a-/i.test(name);
}
