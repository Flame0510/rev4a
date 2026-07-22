import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { requireAuthJWT } from '@/lib/olympus-auth';

const SHARED_SKILLS_DIR = '/docker/shared-skills';

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

    // Sanitize: skill name must be a valid directory name
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(skillName)) {
      return NextResponse.json(
        { error: 'Invalid skill name format' },
        { status: 400 }
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
      content = execFileSync('docker', ['exec', containerName, 'cat', srcPath], {
        encoding: 'utf8', timeout: 5000
      });
    } catch {
      return NextResponse.json(
        { error: `Skill "${skillName}" not found in container ${containerName}` },
        { status: 404 }
      );
    }

    // Check for additional files in the skill directory (assets, scripts, etc.)
    const extraFiles = [];
    try {
      const listRaw = execFileSync('docker', ['exec', containerName, 'ls', '-1p', `/root/.openclaw/workspace/skills/${skillName}/`], {
        encoding: 'utf8', timeout: 5000
      }).trim();
      // Exclude SKILL.md and directories from the extras list
      extraFiles.push(
        ...listRaw.split('\n')
          .map(f => f.trim())
          .filter(f => f && !f.endsWith('/') && f !== 'SKILL.md')
      );
    } catch {
      // No extra files — that's fine
    }

    // Create shared skills directory if it doesn't exist
    const destDir = path.join(SHARED_SKILLS_DIR, skillName);
    fs.mkdirSync(destDir, { recursive: true });

    // Write SKILL.md
    const destPath = path.join(destDir, 'SKILL.md');
    const overwritten = fs.existsSync(destPath);
    fs.writeFileSync(destPath, content, 'utf8');

    // Copy extra files from container
    let extraCopied = 0;
    for (const file of extraFiles) {
      try {
        const fileContent = execFileSync('docker', ['exec', containerName, 'cat', `/root/.openclaw/workspace/skills/${skillName}/${file}`], {
          encoding: 'utf8', timeout: 5000
        });
        fs.writeFileSync(path.join(destDir, file), fileContent, 'utf8');
        extraCopied++;
      } catch {
        // Skip files that can't be read
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
    });
  } catch (err) {
    // Only return message for known Error objects, never raw unknown throws
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
