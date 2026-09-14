import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DB_FILE, AGENTS_TOKEN_FILE, templatesDir } from '@/lib/rev4a-paths';
import { loadOfferedModels } from '@/lib/model-catalogue';
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
      `docker ps --filter "label=AGENT_ID" --format '{{.Names}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!raw) return [];

    // Read AGENT_NAME env from each container (display name)
    const names: string[] = [];
    for (const name of raw.split('\n').filter(Boolean)) {
      try {
        const displayName = execSync(
          `docker exec ${name} sh -c 'echo $AGENT_NAME'`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        if (displayName) names.push(displayName);
      } catch { /* skip */ }
    }
    return names;
  } catch {
    return [];
  }
}

async function getUsedPorts(): Promise<number[]> {
  try {
    const raw = execSync(
      `docker ps --format '{{.Ports}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const ports: number[] = [];
    if (raw) {
      for (const line of raw.split('\n')) {
        const matches = line.match(/(\d+)->/g);
        if (matches) {
          matches.forEach((m) => {
            const p = parseInt(m.replace('->', ''), 10);
            if (!isNaN(p)) ports.push(p);
          });
        }
      }
    }
    // Add Rev4a port as reserved so the client won't suggest it
    ports.push(3740);
    return [...new Set(ports)];
  } catch {
    return [3740];
  }
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
    />
  );
}
