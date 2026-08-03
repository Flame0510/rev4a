import { execSync } from 'child_process';
import { hashToken } from './hash';

export interface AgentContainer {
  name: string;
  agentId: string;
}

/**
 * List running agent containers (those carrying an AGENT_ID label).
 * Shared by the detect API route and the credential delivery layer so both
 * reason over the exact same set of containers.
 */
export function listAgentContainers(): AgentContainer[] {
  try {
    const out = execSync(
      "docker ps --filter label=AGENT_ID --format '{{.Names}}\t{{.Label \"AGENT_ID\"}}'",
      { timeout: 5000, encoding: 'utf-8', maxBuffer: 64 * 1024 },
    ).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, agentId] = line.split('\t');
      return { name: name ?? '', agentId: agentId ?? name ?? '' };
    });
  } catch (e: unknown) {
    throw new Error('listAgentContainers failed: ' + (e as Error).message);
  }
}

/** Run a shell snippet inside a container, parsing stdout with a fallback on error. */
export function execInContainer<T>(
  container: string,
  script: string,
  parse: (raw: string) => T,
  fallback: T,
): T {
  try {
    const raw = execSync(
      `docker exec ${container.replace(/[^a-zA-Z0-9_.-]/g, '')} sh -c ${JSON.stringify(script)}`,
      { timeout: 10000, encoding: 'utf-8', shell: '/bin/bash' },
    ).trim();
    return parse(raw);
  } catch {
    return fallback;
  }
}

/** Trello: presence of the config file marks the CLI as authenticated. */
export function detectTrello(container: string): { loggedIn: boolean } {
  const hasConfig = execInContainer(
    container,
    'test -f /root/.trello-cli/default/config.json && echo yes || echo no',
    (r) => r.trim(),
    'no',
  );
  return { loggedIn: hasConfig === 'yes' };
}

/** Notion: no CLI — just check if the config file exists (same pattern as Trello). */
export function detectNotion(container: string): { loggedIn: boolean } {
  const hasConfig = execInContainer(
    container,
    'test -f /root/.config/notion/config.json && echo yes || echo no',
    (r) => r.trim(),
    'no',
  );
  return { loggedIn: hasConfig === 'yes' };
}
export function cliInstalled(container: string, name: string): boolean {
  const raw = execInContainer(
    container,
    `command -v ${name} >/dev/null 2>&1 && echo yes || echo no`,
    (r) => r.trim(),
    'no',
  );
  return raw === 'yes';
}

/**
 * Secret field that holds the primary token used to match a stored profile
 * against what is installed in a container, per provider.
 */
export const TOKEN_FIELD: Record<string, string> = {
  'github-pat': 'token',
  vercel: 'token',
  supabase: 'accessToken',
  trello: 'token',
  notion: 'token',
};

/** Hash of a stored profile secret's token (empty when unavailable). */
export function profileTokenHash(secret: Record<string, string>, providerId: string): string {
  const field = TOKEN_FIELD[providerId];
  const val = field ? secret[field] : '';
  return val ? hashToken(val) : '';
}

/**
 * Read the token currently installed for a provider inside a container and hash it.
 * Returns '' when nothing is installed or the token cannot be read — callers must
 * treat '' as "unknown / no match" and never as a wildcard.
 */
export function providerTokenHash(container: string, providerId: string): string {
  let raw = '';
  switch (providerId) {
    case 'github-pat':
      raw = execInContainer(
        container,
        "cat /root/.config/gh/hosts.yml 2>/dev/null | grep 'oauth_token:' | head -1 | sed 's/.*: *//'",
        (r) => r.trim(),
        '',
      );
      break;
    case 'vercel':
      raw = execInContainer(
        container,
        "cat /root/.local/share/com.vercel.cli/auth.json 2>/dev/null | grep -oE '\"token\"[^,}]*' | head -1 | grep -oE '\"[^\"]*\"$' | tr -d '\"'",
        (r) => r.trim(),
        '',
      );
      break;
    case 'supabase':
      raw = execInContainer(
        container,
        'cat /root/.supabase/access-token 2>/dev/null | head -1',
        (r) => r.trim(),
        '',
      );
      break;
    case 'trello':
      raw = execInContainer(
        container,
        "cat /root/.trello-cli/default/config.json 2>/dev/null | grep -oE '\"token\"[^,}]*' | head -1 | grep -oE '\"[^\"]*\"$' | tr -d '\"'",
        (r) => r.trim(),
        '',
      );
      break;
    case 'notion':
      raw = execInContainer(
        container,
        "cat /root/.config/notion/config.json 2>/dev/null | grep -oE '\"token\"[^,}]*' | head -1 | grep -oE '\"[^\"]*\"$' | tr -d '\"'",
        (r) => r.trim(),
        '',
      );
      break;
  }
  if (!raw || raw.length < 10) return '';
  return hashToken(raw);
}
