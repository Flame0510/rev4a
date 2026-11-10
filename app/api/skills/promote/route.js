import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { describeAgent } from '@/lib/agent-names';
import { SHARED_SKILLS_DIR } from '@/lib/rev4a-paths';
import { isRev4aOwnedSkill } from '@/lib/rev4a-skills';
import { CONTAINER_NAME_RE } from '@/lib/skill-files';
import { isSafeSkillPromoteName, SKILL_PROMOTE_MAX_FILE_BYTES, SKILL_PROMOTE_MAX_EXTRA_FILES } from '@/lib/skill-promote-names';

class UnsafeDestinationError extends Error {}

function checkDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeDestinationError('Skill destination must be a real directory, not a symlink');
  }
}

function ensureDirectory(dir) {
  try {
    checkDirectory(dir);
    return;
  } catch (err) {
    // lstat catches dangling symlinks too; only create genuinely missing directories.
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (['EEXIST', 'ENOTDIR', 'ELOOP'].includes(err.code)) {
      throw new UnsafeDestinationError('Skill destination must be a real directory, not a symlink');
    }
    throw err;
  }
  checkDirectory(dir);
}

// Check again immediately before each write, including the fixed SKILL.md destination.
function checkedDestination(destDir, name) {
  const destPath = path.resolve(destDir, name);
  if (!isSafeSkillPromoteName(name) || !destPath.startsWith(path.resolve(destDir) + path.sep)) {
    throw new UnsafeDestinationError('Skill destination is outside its directory');
  }
  checkDirectory(SHARED_SKILLS_DIR);
  checkDirectory(destDir);
  const realShared = fs.realpathSync(SHARED_SKILLS_DIR);
  const realDest = fs.realpathSync(destDir);
  if (!realDest.startsWith(realShared + path.sep)) {
    throw new UnsafeDestinationError('Skill destination is outside the shared skills directory');
  }
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UnsafeDestinationError('Skill destination must be a regular file, not a symlink');
    }
    return { destPath, overwritten: true };
  } catch (err) {
    // lstat also finds dangling symlinks; only a genuinely missing path is safe to create.
    if (err.code !== 'ENOENT') throw err;
    return { destPath, overwritten: false };
  }
}

function writeDestination(destDir, name, content) {
  const destination = checkedDestination(destDir, name);
  let fd;
  try {
    // O_NOFOLLOW refuses a symlink swapped in after lstat, before truncating its target.
    fd = fs.openSync(destination.destPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
    fs.writeFileSync(fd, content);
  } catch (err) {
    if (['ELOOP', 'EISDIR', 'ENOTDIR'].includes(err.code)) {
      throw new UnsafeDestinationError('Skill destination must be a regular file, not a symlink');
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return destination;
}

const readOptions = { timeout: 5000, maxBuffer: SKILL_PROMOTE_MAX_FILE_BYTES + 1 };

/**
 * POST /api/skills/promote
 *
 * Copies a skill from an agent container's workspace to the shared skills
 * directory, making it available to all agents via extraDirs.
 *
 * Body: {
 *   containerName: "openclaw-atlas",
 *   skillName: "my-custom-skill"
 * }
 */
export async function POST(request) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  try {
    const { containerName, skillName } = await request.json();

    if (!containerName || !skillName) {
      return NextResponse.json(
        { error: 'containerName and skillName are required' },
        { status: 400 }
      );
    }
    if (typeof containerName !== 'string' || !CONTAINER_NAME_RE.test(containerName)) {
      return NextResponse.json({ error: 'Invalid containerName' }, { status: 400 });
    }

    // Sanitize: skill name must be a valid directory name
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(skillName)) {
      return NextResponse.json(
        { error: 'Invalid skill name format' },
        { status: 400 }
      );
    }

    if (isRev4aOwnedSkill(skillName)) {
      return NextResponse.json(
        { error: `"rev4a-…" is reserved for Rev4a's own skills: rename the skill first` },
        { status: 403 }
      );
    }

    // Verify the container exists and has an AGENT_ID label
    let agentId;
    try {
      agentId = execFileSync('docker', [
        'inspect', containerName,
        '--format', '{{index .Config.Labels "AGENT_ID"}}'
      ], { encoding: 'utf8', timeout: 5000 }).trim();
      if (!agentId) {
        return NextResponse.json(
          { error: `Container ${containerName} has no AGENT_ID label` },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: `Container ${containerName} not found` },
        { status: 404 }
      );
    }

    // Read SKILL.md content from the container
    const srcPath = `/root/.openclaw/workspace/skills/${skillName}/SKILL.md`;
    let content;
    try {
      content = execFileSync('docker', ['exec', containerName, 'cat', srcPath], readOptions);
    } catch (err) {
      if (err.code === 'ENOBUFS') {
        return NextResponse.json({ error: 'SKILL.md exceeds the 1 MiB limit' }, { status: 413 });
      }
      return NextResponse.json(
        { error: `Skill "${skillName}" not found in ${describeAgent(containerName)}` },
        { status: 404 }
      );
    }
    if (content.length > SKILL_PROMOTE_MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'SKILL.md exceeds the 1 MiB limit' }, { status: 413 });
    }

    // Check for additional files in the skill directory (assets, scripts, etc.)
    const extraFiles = [];
    const skipped = [];
    let skippedCount = 0;
    function skip(name) {
      skippedCount++;
      // Bounded sample: at most 50 names of at most 120 characters, so the response stays small.
      if (skipped.length < 50) skipped.push(name.length > 120 ? `${name.slice(0, 120)}…` : name);
    }
    let listRaw = '';
    try {
      listRaw = execFileSync('docker', ['exec', containerName, 'ls', '-1p', `/root/.openclaw/workspace/skills/${skillName}/`], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
      });
    } catch (err) {
      // SKILL.md was just read, so the folder exists: a failed listing is an error, never "no extra files".
      if (err && err.code === 'ENOBUFS') {
        return NextResponse.json({ error: "The skill folder's file list exceeds 1 MiB; nothing was promoted" }, { status: 413 });
      }
      return NextResponse.json({ error: "Could not list the skill's files; nothing was promoted" }, { status: 502 });
    }
    // Iterate without spread or an unbounded array of names. Ignore only the final delimiter.
    for (let start = 0; start < listRaw.length;) {
      const newline = listRaw.indexOf('\n', start);
      const file = listRaw.slice(start, newline === -1 ? listRaw.length : newline);
      start = newline === -1 ? listRaw.length : newline + 1;
      if (file === 'SKILL.md') continue;
      // Folders are not copied (only the skill's top-level files are): report them as skipped.
      if (file.endsWith('/') && isSafeSkillPromoteName(file.slice(0, -1))) { skip(file); continue; }
      if (!isSafeSkillPromoteName(file) || extraFiles.length >= SKILL_PROMOTE_MAX_EXTRA_FILES) {
        skip(file);
        continue;
      }
      extraFiles.push(file);
    }

    // Nested skill names are supported: refuse symlinks at every component before descending.
    let destDir = path.resolve(SHARED_SKILLS_DIR);
    ensureDirectory(destDir);
    for (const part of skillName.split('/')) {
      destDir = path.join(destDir, part);
      ensureDirectory(destDir);
    }

    // Write SKILL.md
    const { destPath, overwritten } = writeDestination(destDir, 'SKILL.md', content);

    // Copy extra files from container
    let extraCopied = 0;
    for (const file of extraFiles) {
      try {
        const fileContent = execFileSync('docker', ['exec', containerName, 'cat', `/root/.openclaw/workspace/skills/${skillName}/${file}`], readOptions);
        if (fileContent.length > SKILL_PROMOTE_MAX_FILE_BYTES) {
          skip(file);
          continue;
        }
        writeDestination(destDir, file, fileContent);
        extraCopied++;
      } catch {
        skip(file);
      }
    }

    return NextResponse.json({
      ok: true,
      skillName,
      agentId,
      containerName,
      destPath,
      overwritten,
      extraCopied,
      skipped,
      skippedCount,
    });
  } catch (err) {
    // Only return message for known Error objects, never raw unknown throws
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: err instanceof UnsafeDestinationError ? 403 : 500 });
  }
}
