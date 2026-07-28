import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

const SHARED_SKILLS_DIR = '/docker/shared-skills';
const CONTAINER_BUNDLED_SKILLS_DIR = '/usr/local/lib/node_modules/openclaw/skills';

function readSkillMeta(skillDir, name, type, agentId) {
  const skillMdPath = path.join(skillDir, name, 'SKILL.md');
  let description = '';
  let version = '';
  let hasSkillMd = false;

  try {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    hasSkillMd = true;
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const verMatch = content.match(/^\*\*Version:\*\*\s*(.+)$/m) || content.match(/^version:\s*(.+)$/m);
    if (descMatch) description = descMatch[1].trim();
    if (verMatch) version = verMatch[1].trim();
  } catch {}

  const result = {
    name,
    type,
    path: path.join(skillDir, name),
    skillMdPath: hasSkillMd ? skillMdPath : null,
    hasSkillMd,
    description,
    version,
  };

  if (agentId) result.agentId = agentId;

  return result;
}

/**
 * Discover agent containers with AGENT_ID label.
 * Returns [{ containerName, agentId }]
 */
function discoverAgentContainers() {
  try {
    // Get container names with AGENT_ID label
    const namesRaw = execFileSync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}}'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!namesRaw) return [];

    return namesRaw.split('\n').map(name => {
      const containerName = name.trim();
      if (!containerName) return null;
      // Get agent ID from label using docker inspect
      const agentId = execFileSync('docker', [
        'inspect', containerName, '--format', '{{index .Config.Labels "AGENT_ID"}}'
      ], { encoding: 'utf8', timeout: 5000 }).trim();
      return { containerName, agentId: agentId || containerName };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read skill directories from a container agent's workspace via docker exec.
 * Returns an array of skill names found.
 */
function readContainerSkillDirs(containerName) {
  const workspaceSkillsPath = '/root/.openclaw/workspace/skills';
  try {
    // Check if the skills directory exists
    execFileSync('docker', ['exec', containerName, 'test', '-d', workspaceSkillsPath], {
      encoding: 'utf8', timeout: 5000
    });

    // List subdirectories (each is a potential skill)
    const raw = execFileSync('docker', ['exec', containerName, 'ls', '-1', workspaceSkillsPath], {
      encoding: 'utf8', timeout: 5000
    }).trim();

    if (!raw) return [];

    return raw.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read SKILL.md content from inside a container.
 */
function readContainerSkillMd(containerName, skillName) {
  const filePath = `/root/.openclaw/workspace/skills/${skillName}/SKILL.md`;
  try {
    return execFileSync('docker', ['exec', containerName, 'cat', filePath], {
      encoding: 'utf8', timeout: 5000
    });
  } catch {
    return null;
  }
}

/**
 * Parse description and version from SKILL.md content string.
 */
function parseSkillContent(content) {
  let description = '';
  let version = '';
  if (!content) return { description, version };

  const descMatch = content.match(/^description:\s*(.+)$/m);
  const verMatch = content.match(/^\*\*Version:\*\*\s*(.+)$/m) || content.match(/^version:\s*(.+)$/m);
  if (descMatch) description = descMatch[1].trim();
  if (verMatch) version = verMatch[1].trim();

  return { description, version };
}

export async function GET(_request) {
  const skills = [];

  // 1. Shared skills
  try {
    if (fs.existsSync(SHARED_SKILLS_DIR)) {
      const entries = fs.readdirSync(SHARED_SKILLS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(SHARED_SKILLS_DIR, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          skills.push(readSkillMeta(SHARED_SKILLS_DIR, entry.name, 'shared', null));
        }
      }
    }
  } catch {}

  // 2. Agent container skills (workspace-local)
  const agents = discoverAgentContainers();
  for (const agent of agents) {
    const dirs = readContainerSkillDirs(agent.containerName);
    for (const dir of dirs) {
      const content = readContainerSkillMd(agent.containerName, dir);
      if (content) {
        const { description, version } = parseSkillContent(content);
        skills.push({
          name: dir,
          type: 'workspace',
          agentId: agent.agentId,
          containerName: agent.containerName,
          path: `/root/.openclaw/workspace/skills/${dir}`,
          skillMdPath: `/root/.openclaw/workspace/skills/${dir}/SKILL.md`,
          hasSkillMd: true,
          description,
          version,
        });
      }
    }
  }

  // 3. Bundled skills (read-only) — discover from any agent container
  try {
    let bundledDirNames = [];
    let bundledSourceContainer = null;

    if (agents.length > 0) {
      for (const agent of agents) {
        try {
          const raw = execFileSync('docker', [
            'exec', agent.containerName, 'ls', '-1', CONTAINER_BUNDLED_SKILLS_DIR
          ], { encoding: 'utf8', timeout: 5000 }).trim();
          if (raw) {
            bundledDirNames = raw.split('\n').map(l => l.trim()).filter(Boolean);
            bundledSourceContainer = agent.containerName;
            break;
          }
        } catch { /* try next container */ }
      }
    }

    for (const name of bundledDirNames) {
      try {
        const skillMdPath = `${CONTAINER_BUNDLED_SKILLS_DIR}/${name}/SKILL.md`;
        const content = execFileSync('docker', [
          'exec', bundledSourceContainer, 'cat', skillMdPath
        ], { encoding: 'utf8', timeout: 5000 });
        const { description, version } = parseSkillContent(content);
        skills.push({
          name,
          type: 'bundled',
          path: `${CONTAINER_BUNDLED_SKILLS_DIR}/${name}`,
          skillMdPath,
          hasSkillMd: true,
          description,
          version,
        });
      } catch { /* skip this skill */ }
    }
  } catch {}

  return NextResponse.json({ skills });
}
