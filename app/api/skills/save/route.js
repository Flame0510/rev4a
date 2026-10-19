import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { describeAgent } from '@/lib/agent-names';
import { SHARED_SKILLS_DIR } from '@/lib/rev4a-paths';
import { dockerExecWithInput } from '@/lib/docker-exec';
import { containerSkillWriteArgv, CONTAINER_NAME_RE } from '@/lib/skill-files';
import { isRev4aOwnedSkill } from '@/lib/rev4a-skills';

const BUNDLED_SKILLS_DIR = '/usr/lib/node_modules/openclaw/skills';

/**
 * Pick an HTTP status from a caught error.
 *
 * Only the deliberate `Object.assign(new Error(…), { status: 404 })` throws in
 * this file carry a real HTTP status. A failing `docker exec` also sets
 * `.status`, but to the process exit code — usually 1. Passing that straight
 * to NextResponse makes undici throw `RangeError: init["status"] must be in
 * the range of 200 to 599`, so the caller got an opaque 500 with no body
 * instead of the intended error. Anything outside the valid range falls back.
 */
function httpStatus(err, fallback) {
  const s = err?.status;
  return Number.isInteger(s) && s >= 200 && s <= 599 ? s : fallback;
}

/**
 * Read SKILL.md content from various sources:
 * - Host path (shared / bundled)
 * - Container path (via docker exec)
 */
function readSkillContent(skillPath, containerName) {
  if (containerName) {
    // Container skill — read via docker exec
    try {
      return execFileSync('docker', ['exec', containerName, 'cat', skillPath], {
        encoding: 'utf8', timeout: 5000
      });
    } catch {
      throw Object.assign(new Error(`Skill not found in ${describeAgent(containerName)}`), { status: 404 });
    }
  }

  // Host skill
  if (!fs.existsSync(skillPath)) {
    throw Object.assign(new Error('Skill not found'), { status: 404 });
  }

  return fs.readFileSync(skillPath, 'utf8');
}

/**
 * Write SKILL.md content.
 * Shared skills — write to host filesystem.
 * Container workspace skills — write via docker exec.
 */
async function writeSkillContent(skillPath, containerName, content) {
  if (containerName) {
    // Container skill — content on stdin, path as a positional argument: nothing
    // from the request is part of a shell string.
    await dockerExecWithInput(containerName, containerSkillWriteArgv(skillPath), content, { timeoutMs: 10000 });
    return;
  }

  // Host skill
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  if (fs.existsSync(skillPath)) {
    fs.copyFileSync(skillPath, skillPath + '.bak');
  }
  fs.writeFileSync(skillPath, content, 'utf8');
}

export async function POST(request) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  try {
    const { skillPath, content, containerName } = await request.json();

    if (!skillPath || !content) {
      return NextResponse.json({ error: 'Missing skillPath or content' }, { status: 400 });
    }
    if (typeof skillPath !== 'string' || typeof content !== 'string') {
      return NextResponse.json({ error: 'skillPath and content must be strings' }, { status: 400 });
    }

    // Validate path ends with SKILL.md
    if (!skillPath.endsWith('SKILL.md')) {
      return NextResponse.json({ error: 'Only SKILL.md files can be saved' }, { status: 403 });
    }

    // Determine if this is a shared, bundled, or container skill
    const absPath = path.resolve(skillPath);
    const absShared = path.resolve(SHARED_SKILLS_DIR);
    const absBundled = path.resolve(BUNDLED_SKILLS_DIR);

    const isShared = absPath.startsWith(absShared + path.sep) || absPath === absShared;
    const isBundled = absPath.startsWith(absBundled + path.sep) || absPath === absBundled;
    const isContainer = !!containerName;

    if (containerName !== undefined && containerName !== null && containerName !== '' &&
        (typeof containerName !== 'string' || !CONTAINER_NAME_RE.test(containerName))) {
      return NextResponse.json({ error: 'Invalid containerName' }, { status: 400 });
    }

    if (!isContainer && isShared) {
      const first = path.relative(absShared, absPath).split(path.sep)[0];
      if (isRev4aOwnedSkill(first)) {
        return NextResponse.json({ error: "Rev4a's own skills are managed by Rev4a and cannot be edited" }, { status: 403 });
      }
    }

    if (isBundled) {
      return NextResponse.json({ error: 'Bundled skills are read-only' }, { status: 403 });
    }

    if (!isShared && !isContainer) {
      return NextResponse.json({ error: 'Path not in allowed roots and no containerName provided' }, { status: 403 });
    }

    await writeSkillContent(isContainer ? skillPath : absPath, containerName || null, content);

    return NextResponse.json({ ok: true, saved: isContainer ? skillPath : absPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: httpStatus(err, 500) });
  }
}

export async function GET(request) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const skillPath = searchParams.get('path');
  const containerName = searchParams.get('containerName');

  if (!skillPath) {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 });
  }

  try {
    if (containerName) {
      // Read from container via docker exec
      const content = readSkillContent(skillPath, containerName);
      return NextResponse.json({ content });
    }

    // Read from host path
    const absPath = path.resolve(skillPath);
    const absShared = path.resolve(SHARED_SKILLS_DIR);
    const absBundled = path.resolve(BUNDLED_SKILLS_DIR);

    const isShared = absPath.startsWith(absShared + path.sep) || absPath === absShared;
    const isBundled = absPath.startsWith(absBundled + path.sep) || absPath === absBundled;

    if (!isShared && !isBundled) {
      return NextResponse.json({ error: 'Host path not in allowed skill roots' }, { status: 403 });
    }

    const content = readSkillContent(absPath, null);
    return NextResponse.json({ content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: httpStatus(err, 404) });
  }
}
