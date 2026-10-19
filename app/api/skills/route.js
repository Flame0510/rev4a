import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { getAgentDisplayNames } from '@/lib/agent-names';
import { SHARED_SKILLS_DIR } from '@/lib/rev4a-paths';
import { dockerExecShellNoFail, mapWithConcurrency } from '@/lib/docker-exec';
import { isRev4aOwnedSkill } from '@/lib/rev4a-skills';

const execFileAsync = promisify(execFile);

const CONTAINER_BUNDLED_SKILLS_DIR = '/usr/local/lib/node_modules/openclaw/skills';
const WORKSPACE_SKILLS_DIR = '/root/.openclaw/workspace/skills';

/** Agents read at once — each is a single bulk `docker exec`. */
const AGENT_QUERY_CONCURRENCY = 6;

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
async function discoverAgentContainers() {
  try {
    // `docker ps` prints labels itself, so the AGENT_ID comes back with the name.
    // This used to follow up with a `docker inspect` per container to read that
    // same label — N+1 process spawns for data the first call already had.
    const { stdout } = await execFileAsync('docker', [
      'ps', '--filter', 'label=AGENT_ID', '--format', '{{.Label "AGENT_ID"}}\t{{.Names}}'
    ], { encoding: 'utf8', timeout: 5000 });

    return stdout.trim().split('\n').map(line => {
      const [agentId, containerName] = line.split('\t');
      if (!containerName?.trim()) return null;
      return { containerName: containerName.trim(), agentId: agentId?.trim() || containerName.trim() };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read every SKILL.md under `dir` in one shot.
 *
 * The previous approach ran `docker exec … cat` once per skill. With 52 bundled
 * skills in the base image that was 52 sequential process spawns at ~260ms each
 * — roughly 13s of blocked event loop to read 52 text files sitting in the same
 * container.
 *
 * The shell loop emits `path\0content\0` pairs. NUL is the delimiter precisely
 * because it cannot occur inside the text files being read, so no SKILL.md can
 * forge a record boundary — a risk any printable separator would carry.
 *
 * Returns a Map of skill name → SKILL.md contents.
 */
async function readSkillsBulk(containerName, dir) {
  const script =
    `for d in ${dir}/*/; do ` +
    `[ -f "$d/SKILL.md" ] || continue; ` +
    `n=$(basename "$d"); ` +
    `printf '%s\\0' "$n"; ` +
    `cat "$d/SKILL.md"; ` +
    `printf '\\0'; ` +
    `done`;

  const raw = await dockerExecShellNoFail(containerName, script, {
    timeoutMs: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const out = new Map();
  if (!raw) return out;

  const parts = raw.split('\0');
  // Pairs of name, content — a trailing empty element from the final NUL is fine.
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const name = parts[i].trim();
    if (name) out.set(name, parts[i + 1]);
  }
  return out;
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

export async function GET(request) {
  const denied = await requireAuthJWT(request); if (denied) return denied;
  const skills = [];

  // 1. Shared skills
  try {
    if (fs.existsSync(SHARED_SKILLS_DIR)) {
      const entries = fs.readdirSync(SHARED_SKILLS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(SHARED_SKILLS_DIR, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const meta = readSkillMeta(SHARED_SKILLS_DIR, entry.name, 'shared', null);
          if (isRev4aOwnedSkill(entry.name)) meta.managed = true;
          skills.push(meta);
        }
      }
    }
  } catch {}

  // 2. Agent container skills (workspace-local) — one bulk read per agent,
  //    agents queried concurrently.
  const agents = await discoverAgentContainers();
  // Display names (AGENT_NAME) for the labels; one cached inspect, never an exec per agent.
  const agentNames = await getAgentDisplayNames(agents.map((a) => a.containerName));
  const perAgent = await mapWithConcurrency(agents, AGENT_QUERY_CONCURRENCY, (agent) =>
    readSkillsBulk(agent.containerName, WORKSPACE_SKILLS_DIR),
  );

  for (const [i, found] of perAgent.entries()) {
    const agent = agents[i];
    for (const [name, content] of found) {
      const { description, version } = parseSkillContent(content);
      skills.push({
        name,
        type: 'workspace',
        agentId: agent.agentId,
        containerName: agent.containerName,
        agentName: agentNames.get(agent.containerName) || null,
        path: `${WORKSPACE_SKILLS_DIR}/${name}`,
        skillMdPath: `${WORKSPACE_SKILLS_DIR}/${name}/SKILL.md`,
        hasSkillMd: true,
        description,
        version,
      });
    }
  }

  // 3. Bundled skills (read-only) — identical in every agent, so the first
  //    container that answers is enough. One bulk read instead of 52 `cat`s.
  try {
    for (const agent of agents) {
      const found = await readSkillsBulk(agent.containerName, CONTAINER_BUNDLED_SKILLS_DIR);
      if (found.size === 0) continue; // container not ready — try the next one

      for (const [name, content] of found) {
        const { description, version } = parseSkillContent(content);
        skills.push({
          name,
          type: 'bundled',
          path: `${CONTAINER_BUNDLED_SKILLS_DIR}/${name}`,
          skillMdPath: `${CONTAINER_BUNDLED_SKILLS_DIR}/${name}/SKILL.md`,
          hasSkillMd: true,
          description,
          version,
        });
      }
      break;
    }
  } catch {}

  return NextResponse.json({ skills });
}
