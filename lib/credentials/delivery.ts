import { execSync } from 'child_process';
import { getSecret, listProfiles } from './vault';
import { getProvider } from './providers';
import { listAgentContainers as listAgentContainerInfo } from './detect';

export interface SyncResult {
  container: string;
  status: 'ok' | 'error';
  error?: string;
}

// ── Container discovery ────────────────────────────────────────────────────

// Container names only, tolerant of docker failures (shared discovery lives in detect.ts).
function listAgentContainers(): string[] {
  try {
    return listAgentContainerInfo().map((c) => c.name).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Exec helpers ───────────────────────────────────────────────────────────

function containerExec(container: string, script: string, timeoutMs = 30000): void {
  execSync(`docker exec ${container} sh -c ${JSON.stringify(script)}`, {
    timeout: timeoutMs,
    stdio: 'pipe',
  });
}

function containerRead(container: string, path: string): string {
  try {
    return execSync(
      `docker exec ${container} sh -c ${JSON.stringify(`cat ${path} 2>/dev/null || true`)}`,
      { timeout: 5000, encoding: 'utf-8', maxBuffer: 512 * 1024 },
    );
  } catch {
    return '';
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}


// ── Per-provider delivery adapters ────────────────────────────────────────

interface VercelUserResponse { user?: { id?: string; defaultTeamId?: string } }
interface VercelTeam { id: string; slug: string }
interface VercelTeamsResponse { teams?: VercelTeam[] }

/**
 * Validate a Vercel token against the API and discover its accessible team scope.
 * Returns the token and the team ID (not slug) to use in config.json.
 * Uses Node.js fetch() instead of curl — token never appears in command line.
 */
async function discoverVercelScope(token: string): Promise<{ token: string; teamId: string | null }> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Validate token + get user info
  const userRes = await fetch('https://api.vercel.com/v2/user', { headers, signal: AbortSignal.timeout(10000) });
  if (!userRes.ok) throw new Error(`Vercel API returned ${userRes.status} for /v2/user`);
  const userData: VercelUserResponse = await userRes.json() as VercelUserResponse;
  if (!userData?.user?.id) throw new Error('Invalid token response from Vercel API');

  let teamId: string | null = null;
  try {
    const teamsRes = await fetch('https://api.vercel.com/v2/teams', { headers, signal: AbortSignal.timeout(10000) });
    if (teamsRes.ok) {
      const teamsData: VercelTeamsResponse = await teamsRes.json() as VercelTeamsResponse;
      const teams = teamsData?.teams;
      if (teams && teams.length > 0) {
        const defaultTeamId = userData.user.defaultTeamId;
        const defaultTeam = defaultTeamId
          ? teams.find((t) => t.id === defaultTeamId)
          : undefined;
        teamId = (defaultTeam ?? teams[0]).id;
      }
    }
  } catch {
    // Personal token, no team scope needed
  }

  return { token, teamId };
}

function deliverGithub(container: string, secret: Record<string, string>): void {
  const { token } = secret;
  if (!token) throw new Error('Missing token');

  // Require gh CLI preinstalled in the agent image
  const hasGh = execSync(
    `docker exec ${container} sh -c ${JSON.stringify('command -v gh >/dev/null 2>&1 && echo ok || echo missing')}`,
    { timeout: 5000, encoding: 'utf-8' },
  ).trim();
  if (hasGh !== 'ok') throw new Error('gh CLI not installed in this container. Rebuild the base image: docker build -t openclaw-agent-base:latest agent-templates/base-image/');

  containerExec(
    container,
    `echo ${JSON.stringify(b64(token))} | base64 -d | gh auth login --with-token`,
  );
}

async function deliverVercel(container: string, secret: Record<string, string>): Promise<void> {
  const { token } = secret;
  if (!token) throw new Error('Missing token');

  // Require vercel CLI preinstalled in the agent image
  const hasVercel = execSync(
    `docker exec ${container} sh -c ${JSON.stringify('command -v vercel >/dev/null 2>&1 && echo ok || echo missing')}`,
    { timeout: 5000, encoding: 'utf-8' },
  ).trim();
  if (hasVercel !== 'ok') throw new Error('vercel CLI not installed in this container. Rebuild the base image: docker build -t openclaw-agent-base:latest agent-templates/base-image/');

  // Validate token and discover team scope via Node fetch (no curl/exec)
  const scope = await discoverVercelScope(token);

  // Write auth.json for Vercel CLI auth — same directory as config.json
  const authJson = JSON.stringify({ token });
  containerExec(
    container,
    `mkdir -p /root/.local/share/com.vercel.cli && echo ${JSON.stringify(b64(authJson))} | base64 -d > /root/.local/share/com.vercel.cli/auth.json && chmod 600 /root/.local/share/com.vercel.cli/auth.json`,
  );

  // Write config.json with currentTeam = team ID (prevents scope errors like "ledger")
  // Both auth.json and config.json MUST be in ~/.local/share/com.vercel.cli/
  if (scope.teamId) {
    const vercelConfig = JSON.stringify({ currentTeam: scope.teamId });
    containerExec(
      container,
      `echo ${JSON.stringify(b64(vercelConfig))} | base64 -d > /root/.local/share/com.vercel.cli/config.json && chmod 600 /root/.local/share/com.vercel.cli/config.json`,
    );
  }

}

function deliverSupabase(container: string, secret: Record<string, string>): void {
  const { accessToken } = secret;
  if (!accessToken || !accessToken.trim()) throw new Error('Missing Supabase access token');

  // Check supabase CLI is available (installed globally in the image)
  const hasSupabase = execSync(
    `docker exec ${container} sh -c ${JSON.stringify('command -v supabase >/dev/null 2>&1 && echo ok || echo missing')}`,
    { timeout: 5000, encoding: 'utf-8' },
  ).trim();
  if (hasSupabase !== 'ok') throw new Error('supabase CLI not installed in this container. Rebuild the base image: docker build -t openclaw-agent-base:latest agent-templates/base-image/');

  // Login with access token — grants access to all projects on the account
  // supabase login --token supports non-interactive auth
  containerExec(
    container,
    `supabase login --token ${JSON.stringify(accessToken.trim())} --no-browser 2>&1`,
    30000,
  );
}

function deliverTrello(container: string, secret: Record<string, string>): void {
  const { apiKey, token } = secret;
  if (!apiKey || !token) throw new Error('Missing Trello API key or token');

  // Require trello CLI preinstalled in the agent image
  const hasTrello = execSync(
    `docker exec ${container} sh -c ${JSON.stringify('command -v trello >/dev/null 2>&1 && echo ok || echo missing')}`,
    { timeout: 5000, encoding: 'utf-8' },
  ).trim();
  if (hasTrello !== 'ok') throw new Error('trello CLI not installed in this container. Rebuild the base image: docker build -t openclaw-agent-base:latest agent-templates/base-image/');

  // Write trello-cli config file (same format trello auth would create)
  const config = JSON.stringify({ apiKey, token });
  containerExec(
    container,
    `mkdir -p /root/.trello-cli/default && echo ${JSON.stringify(b64(config))} | base64 -d > /root/.trello-cli/default/config.json && chmod 600 /root/.trello-cli/default/config.json`,
  );
}

/** Notion: no CLI, just write a config file (same pattern as Trello). */
function deliverNotion(container: string, secret: Record<string, string>): void {
  const { token } = secret;
  if (!token) throw new Error('Missing Notion API token');

  const config = JSON.stringify({ token });
  containerExec(
    container,
    `mkdir -p /root/.config/notion && echo ${JSON.stringify(b64(config))} | base64 -d > /root/.config/notion/config.json && chmod 600 /root/.config/notion/config.json`,
  );
}

// ── TOOLS.md managed section (per-container) ──────────────────────────────

const MARKER_START = '<!-- OLYMPUS:INTEGRATIONS:START -->';
const MARKER_END = '<!-- OLYMPUS:INTEGRATIONS:END -->';
const TOOLS_MD_PATH = '/root/.openclaw/workspace/TOOLS.md';

interface IntegrationEntry {
  tool: string;
  status: string;
  note: string;
}

const PROVIDER_ENTRIES: Record<string, IntegrationEntry> = {
  'github-pat': {
    tool: 'gh',
    status: '✓ ready',
    note: 'GitHub CLI — `gh api`, `gh repo clone`, `gh pr create`, `gh issue list`',
  },
  vercel: {
    tool: 'vercel',
    status: '✓ ready',
    note: 'Vercel CLI — `vercel list`, `vercel deploy`, `vercel env pull`',
  },
  supabase: {
    tool: 'supabase',
    status: '✓ ready',
    note: 'Supabase CLI — `supabase login`, `supabase db push/pull`, `supabase functions deploy`, `supabase projects list`',
  },
  trello: {
    tool: 'trello',
    status: '✓ ready',
    note: 'Trello CLI — `trello card:list`, `trello card:create`, `trello interactive`',
  },
  notion: {
    tool: 'notion',
    status: '✓ ready',
    note: 'Notion API — read/write pages, databases, and blocks via REST API',
  },
};

function entryRow(entry: IntegrationEntry): string {
  return `| \`${entry.tool}\` | ${entry.status} | ${entry.note} |`;
}

function buildBlock(integrations: IntegrationEntry[]): string {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  if (integrations.length === 0) {
    return `${MARKER_START}\n_No integrations configured via Olympus._\n${MARKER_END}`;
  }

  const rows = integrations.map((e) => entryRow(e)).join('\n');
  return `${MARKER_START}
## Active Integrations

> Managed by Olympus — do not edit this section manually. Last synced: ${ts}

| Tool | Status | Notes |
|---|---|---|
${rows}

${MARKER_END}`;
}

function collectIntegrations(): IntegrationEntry[] {
  const profiles = listProfiles();
  const seen = new Set<string>();
  const entries: IntegrationEntry[] = [];

  for (const profile of profiles) {
    if (profile.status !== 'active') continue;
    if (seen.has(profile.providerId)) continue;
    seen.add(profile.providerId);

    const entry = PROVIDER_ENTRIES[profile.providerId];
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Helper: extract rows as pure string lines from the block content (between markers).
 */
function extractRows(existing: string, si: number, ei: number): string[] {
  const between = existing.slice(si + MARKER_START.length, ei);
  const content = between.trim();
  return content.split('\n').filter((l) => l.trim().startsWith('|'));
}

/**
 * Helper: convert raw row strings back to IntegrationEntry for buildBlock.
 */
function rowsToEntries(rows: string[]): IntegrationEntry[] {
  return rows
    .map((r) => {
      const parts = r.split('|').map((s) => s.trim());
      const toolPart = parts[1] ?? '';
      const toolName = toolPart.replace(/^`|`$/g, '');
      return Object.values(PROVIDER_ENTRIES).find((e) => e.tool === toolName);
    })
    .filter(Boolean) as IntegrationEntry[];
}

/**
 * Add or remove a single provider's row from the TOOLS.md integration block
 * inside a single agent container (docker exec only, no host filesystem access).
 */
function toggleProviderRow(
  container: string,
  providerId: string,
  action: 'add' | 'remove',
): void {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  const entry = PROVIDER_ENTRIES[providerId];
  if (!entry) return;

  const existing = containerRead(safe, TOOLS_MD_PATH);
  const row = entryRow(entry);
  const si = existing.indexOf(MARKER_START);
  const ei = existing.indexOf(MARKER_END);

  let rows: string[];

  if (action === 'add') {
    if (si !== -1 && ei !== -1 && ei > si) {
      rows = extractRows(existing, si, ei);
      if (!rows.some((r) => r.includes(`\`${entry.tool}\``))) {
        rows.push(row);
      }
    } else {
      // No block yet — create one with just this row
      const newBlock = buildBlock([entry]);
      containerExec(
        safe,
        `echo ${JSON.stringify(b64(newBlock + '\n' + existing))} | base64 -d > ${TOOLS_MD_PATH}`,
      );
      return;
    }
  } else {
    // action === 'remove'
    if (si === -1 || ei === -1 || ei <= si) return; // No block to edit
    rows = extractRows(existing, si, ei).filter((r) => !r.includes(`\`${entry.tool}\``));
  }

  const newBlock = buildBlock(rowsToEntries(rows));
  const patched = existing.slice(0, si) + newBlock + existing.slice(ei + MARKER_END.length);
  containerExec(
    safe,
    `echo ${JSON.stringify(b64(patched))} | base64 -d > ${TOOLS_MD_PATH}`,
  );
}

// ── Agent primitives — operate on ONE container ──────────────────────────

/**
 * Remove credentials for a specific provider from a single agent container.
 */
function cleanProvider(container: string, providerId: string): void {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  switch (providerId) {
    case 'github-pat':
      try { containerExec(safe, 'rm -rf /root/.config/gh /root/.local/share/gh 2>/dev/null; exit 0', 10000); } catch {}
      break;
    case 'vercel':
      try { containerExec(safe, 'rm -rf /root/.local/share/com.vercel.cli', 10000); } catch {}
      break;
    case 'supabase':
      try { containerExec(safe, 'rm -f /root/.supabase/access-token 2>/dev/null; exit 0', 10000); } catch {}
      break;
    case 'trello':
      try { containerExec(safe, 'rm -rf /root/.trello-cli', 10000); } catch {}
      break;
    case 'notion':
      try { containerExec(safe, 'rm -rf /root/.config/notion', 10000); } catch {}
      break;
  }
}

/**
 * Inject a credential for a given provider into a single agent container.
 */
async function deliverToAgent(
  container: string,
  providerId: string,
  secret: Record<string, string>,
): Promise<void> {
  switch (providerId) {
    case 'github-pat': deliverGithub(container, secret); break;
    case 'vercel':     await deliverVercel(container, secret); break;
    case 'supabase':   deliverSupabase(container, secret); break;
    case 'trello':     deliverTrello(container, secret); break;
    case 'notion':     deliverNotion(container, secret); break;
    default: throw new Error(`No delivery adapter for: ${providerId}`);
  }
}

/**
 * Sync a credential to specific containers.
 *
 * - Cleans credentials from selected containers, then delivers new ones.
 * - Manages the TOOLS.md integration block row-by-row for the given provider only.
 * - Unselected containers are NOT touched.
 */
export async function syncProfileToAgents(
  profileId: string,
  providerId: string,
  containers?: string[],
): Promise<SyncResult[]> {
  if (!getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);

  const secret = getSecret(profileId);
  const selectedTargets = containers ?? listAgentContainers();

  // Clean the specific provider from selected targets (don't touch other providers)
  for (const container of selectedTargets) {
    cleanProvider(container, providerId);
  }

  // Deliver credentials to selected targets
  const results: SyncResult[] = [];
  for (const container of selectedTargets) {
    const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe) continue;

    try {
      await deliverToAgent(safe, providerId, secret);
      results.push({ container, status: 'ok' });
    } catch (e: unknown) {
      results.push({ container, status: 'error', error: (e as Error).message });
    }
  }

  // Update TOOLS.md on selected targets only
  for (const container of selectedTargets) {
    const wasDelivered = results.some(
      (r) => r.container === container && r.status === 'ok',
    );
    toggleProviderRow(container, providerId, wasDelivered ? 'add' : 'remove');
  }

  return results;
}

/**
 * Clean a single provider from a single agent container and update its TOOLS.md.
 * Used by the De-sync button in the UI and by the sync endpoint for initial cleanup.
 */
export function cleanAgentProviders(container: string, providerId: string): void {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  cleanProvider(safe, providerId);
  toggleProviderRow(safe, providerId, 'remove');
}
