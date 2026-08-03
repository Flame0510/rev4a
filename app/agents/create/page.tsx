import { requireAuth } from '@/lib/requireAuth';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DB_FILE, AGENTS_TOKEN_FILE, MODELS_CONFIG_FILE, PROVIDER_KEYS_FILE, templatesDir } from '@/lib/olympus-paths';
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
  try {
    const raw = fs.readFileSync(MODELS_CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    const allModels: ModelInfo[] = (config.models || []).filter((m: { enabled: boolean }) => m.enabled !== false);

    let configuredProviders: string[] = [];
    try {
      const keysRaw = fs.readFileSync(PROVIDER_KEYS_FILE, 'utf-8');
      configuredProviders = Object.keys(JSON.parse(keysRaw));
    } catch { /* no keys configured yet */ }

    if (configuredProviders.length > 0) {
      return allModels.filter((m) => configuredProviders.includes(m.provider));
    }

    // No providers configured — show no models
    return [];
  } catch {
    return [];
  }
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
    // Add Olympus port as reserved so the client won't suggest it
    ports.push(3740);
    return [...new Set(ports)];
  } catch {
    return [3740];
  }
}

export default async function CreateAgentPage() {
  await requireAuth();

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
