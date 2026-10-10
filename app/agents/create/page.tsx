import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DB_FILE, AGENTS_TOKEN_FILE, templatesDir } from '@/lib/rev4a-paths';
import { REV4A_PORT } from '@/lib/agent-ports';
import { getUsedHostPorts } from '@/lib/agent-ports-server';
import { loadOfferedModels } from '@/lib/model-catalogue';
import { readAgentDefaults } from '@/lib/agent-defaults';
import CreatePageClient from './PageClient';

export const dynamic = 'force-dynamic';

interface TemplateInfo {
  id: string;
  files: string[];
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

async function getTemplates(): Promise<TemplateInfo[]> {
  const dir = templatesDir(process.cwd());
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'base-image')
      .map((e) => ({
        id: e.name,
        files: fs.readdirSync(path.join(dir, e.name)),
      }));
  } catch {
    return [];
  }
}

async function getModels(): Promise<ModelInfo[]> {
  // Through the shared definition, not a raw file read. Reading the bundle
  // directly skipped model-overrides.json, so a model the operator had switched
  // off on the Gateway page was still offered here — and one they had switched
  // on was missing. On the production host that was 58 models listed against 62
  // correct: two offered that should not be, six absent that should be.
  return loadOfferedModels().map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
}

async function getUsedNames(): Promise<string[]> {
  try {
    const raw = execSync(
      `docker ps -a --filter "label=AGENT_ID" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!raw) return [];

    // Read AGENT_NAME from each container's inspect: a stopped agent still owns its
    // display name, and `docker exec` cannot reach a stopped container.
    const names: string[] = [];
    for (const name of raw.split('\n').filter(Boolean)) {
      try {
        const env = execSync(
          `docker inspect ${name} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
          { encoding: 'utf-8', timeout: 3000 },
        );
        const displayName = env.match(/^AGENT_NAME=(.*)$/m)?.[1]?.trim();
        if (displayName) names.push(displayName);
      } catch { /* skip */ }
    }
    return names;
  } catch {
    return [];
  }
}

async function getUsedPorts(): Promise<number[]> {
  // One source for port occupancy (lib/agent-ports-server.ts): it reads every
  // container's bindings, so the block of a stopped agent is offered to nobody.
  const ports = await getUsedHostPorts();
  ports.add(REV4A_PORT);
  return [...ports];
}

export default async function CreateAgentPage() {

  const [templates, models, usedNames, usedPorts] = await Promise.all([
    getTemplates(),
    getModels(),
    getUsedNames(),
    getUsedPorts(),
  ]);

  return (
    <CreatePageClient
      templates={templates}
      models={models}
      usedNames={usedNames}
      usedPorts={usedPorts}
      defaultMemoryLimitMb={readAgentDefaults().memoryLimitMb}
    />
  );
}
