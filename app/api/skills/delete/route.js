import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';

const SHARED_SKILLS_DIR = '/docker/shared-skills';

/**
 * DELETE /api/skills/delete
 *
 * Deletes a skill. Supports two modes:
 * - shared: removes from /docker/shared-skills/
 * - workspace/container: removes from container via docker exec rm -rf
 *
 * Body: { skillName, containerName? }
 */
export async function DELETE(request) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;

  try {
    const { skillName, containerName } = await request.json();

    if (!skillName) {
      return NextResponse.json(
        { error: 'skillName is required' },
        { status: 400 }
      );
    }

    // Sanitize: prevent path traversal
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(skillName)) {
      return NextResponse.json(
        { error: 'Invalid skill name format' },
        { status: 400 }
      );
    }

    if (containerName) {
      // Delete from agent container workspace
      const skillDir = `/root/.openclaw/workspace/skills/${skillName}`;

      // Verify container exists
      try {
        execFileSync('docker', ['inspect', containerName], { encoding: 'utf8', timeout: 5000 });
      } catch {
        return NextResponse.json(
          { error: `Container ${containerName} not found` },
          { status: 404 }
        );
      }

      // Check if skill exists in container
      try {
        execFileSync('docker', ['exec', containerName, 'test', '-d', skillDir], { encoding: 'utf8', timeout: 5000 });
      } catch {
        return NextResponse.json(
          { error: `Skill "${skillName}" not found in container ${containerName}` },
          { status: 404 }
        );
      }

      execFileSync('docker', ['exec', containerName, 'rm', '-rf', skillDir], { encoding: 'utf8', timeout: 10000 });

      return NextResponse.json({
        ok: true,
        skillName,
        containerName,
        deleted: true,
        from: 'workspace',
      });
    }

    // Delete from shared skills directory
    const skillDir = path.join(SHARED_SKILLS_DIR, skillName);

    if (!fs.existsSync(skillDir)) {
      return NextResponse.json(
        { error: `Skill "${skillName}" not found in shared skills` },
        { status: 404 }
      );
    }

    // Prevent deletion of non-shared paths (safety check)
    if (!skillDir.startsWith(SHARED_SKILLS_DIR)) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 400 }
      );
    }

    fs.rmSync(skillDir, { recursive: true, force: true });

    return NextResponse.json({
      ok: true,
      skillName,
      deleted: true,
      from: 'shared',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
