import { dockerExecShell, mapWithConcurrency } from '@/lib/docker-exec';
import { getSecret } from './vault';
import { getProvider } from './providers';
import { listAgentContainers as listAgentContainerInfo } from './detect';

/** Containers written to at once. Writes are heavier than reads, so lower. */
const AGENT_WRITE_CONCURRENCY = 4;

export interface SyncResult {
  container: string;
  status: 'ok' | 'error';
  error?: string;
}

// ── Container discovery ────────────────────────────────────────────────────

// Container names only, tolerant of docker failures (shared discovery lives in detect.ts).
// Async because discovery moved off `execSync`; the only caller is already async.
async function listAgentContainers(): Promise<string[]> {
  try {
    return (await listAgentContainerInfo()).map((c) => c.name).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Exec helpers ───────────────────────────────────────────────────────────

/**
 * Run a shell snippet inside a container.
 *
 * Goes through `dockerExecShell`, which spawns docker with an argv array and no
 * host shell in between, so `script` reaches `sh -c` inside the container
 * verbatim. That matters: were the command assembled as one string for a host
 * shell, a `$(...)` or a backtick anywhere in it — including inside a secret
 * interpolated into it — would execute on the host, as the user running the
 * dashboard, before docker was ever invoked.
 *
 * Secrets must still never be interpolated into `script`. Pass them via `env` and
 * reference them as "$KEY": parameter expansion does not re-parse the value for
 * command substitution. Only the name reaches argv, as `docker exec -e KEY`;
 * docker forwards the value from its own environment, so it appears neither in
 * the host process table nor in any rejection built from that argv.
 */
async function containerExec(
  container: string,
  script: string,
  timeoutMs = 30000,
  env?: Record<string, string>,
): Promise<void> {
  await dockerExecShell(container, script, { timeoutMs, env });
}

/** Whether a CLI is on PATH inside the container. Throws if the exec fails. */
async function cliPresent(container: string, name: string): Promise<boolean> {
  const out = await dockerExecShell(
    container,
    `command -v ${name} >/dev/null 2>&1 && echo ok || echo missing`,
    { timeoutMs: 5000 },
  );
  return out.trim() === 'ok';
}

/** Printed after the file, so its absence proves the read was cut short. */
const READ_COMPLETE = '\x04';

/**
 * Read a file from a container.
 *
 * Returns '' when the file is genuinely absent or empty, and null when the read
 * did not complete. Callers that write the file back MUST treat null as "do not
 * write": to the rewrite path an unfinished read is indistinguishable from an
 * empty file, and TOOLS.md's "no block yet" branch replaces the whole file.
 *
 * A try/catch alone does not separate the two, which is the trap this function
 * was already caught in. `docker exec` exits 0 on the SIGTERM a timeout sends,
 * so a read killed halfway *resolves* with whatever it had printed — no
 * rejection to catch. `detect.ts` relies on that same behaviour deliberately for
 * its probe sentinel; here it has to be defended against, and by the same means:
 * a terminator written last. Present, the content is whole; absent, the process
 * died before the end and nothing may be concluded from what arrived.
 *
 * `;` rather than `|| true`: when the file really is missing `cat` fails, the
 * terminator is still printed, and the caller correctly gets '' — the case that
 * must still create TOOLS.md, since an agent from the `custom` template starts
 * without one until OpenClaw writes it.
 */
async function containerRead(container: string, path: string): Promise<string | null> {
  try {
    const raw = await dockerExecShell(container, `cat ${path} 2>/dev/null; printf '\\4'`, {
      timeoutMs: 5000,
      maxBuffer: 512 * 1024,
    });
    if (!raw.endsWith(READ_COMPLETE)) return null;
    return raw.slice(0, -READ_COMPLETE.length);
  } catch {
    return null;
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

async function deliverGithub(container: string, secret: Record<string, string>): Promise<void> {
  const { token } = secret;
  if (!token) throw new Error('Missing token');

  // Require gh CLI preinstalled in the agent image
  if (!await cliPresent(container, 'gh')) throw new Error('gh CLI not installed in this container. Download the current agent image from the Agents page and update this agent.');

  await containerExec(
    container,
    `echo ${JSON.stringify(b64(token))} | base64 -d | gh auth login --with-token`,
  );
}

async function deliverVercel(container: string, secret: Record<string, string>): Promise<void> {
  const { token } = secret;
  if (!token) throw new Error('Missing token');

  // Require vercel CLI preinstalled in the agent image
  if (!await cliPresent(container, 'vercel')) throw new Error('vercel CLI not installed in this container. Download the current agent image from the Agents page and update this agent.');

  // Validate token and discover team scope via Node fetch (no curl/exec)
  const scope = await discoverVercelScope(token);

  // Write auth.json for Vercel CLI auth — same directory as config.json
  const authJson = JSON.stringify({ token });
  await containerExec(
    container,
    `mkdir -p /root/.local/share/com.vercel.cli && echo ${JSON.stringify(b64(authJson))} | base64 -d > /root/.local/share/com.vercel.cli/auth.json && chmod 600 /root/.local/share/com.vercel.cli/auth.json`,
  );

  // Write config.json with currentTeam = team ID (prevents scope errors like "ledger")
  // Both auth.json and config.json MUST be in ~/.local/share/com.vercel.cli/
  if (scope.teamId) {
    const vercelConfig = JSON.stringify({ currentTeam: scope.teamId });
    await containerExec(
      container,
      `echo ${JSON.stringify(b64(vercelConfig))} | base64 -d > /root/.local/share/com.vercel.cli/config.json && chmod 600 /root/.local/share/com.vercel.cli/config.json`,
    );
  }

}

async function deliverSupabase(container: string, secret: Record<string, string>): Promise<void> {
  const { accessToken } = secret;
  if (!accessToken || !accessToken.trim()) throw new Error('Missing Supabase access token');

  // Check supabase CLI is available (installed globally in the image)
  if (!await cliPresent(container, 'supabase')) throw new Error('supabase CLI not installed in this container. Download the current agent image from the Agents page and update this agent.');

  // Login with access token — grants access to all projects on the account
  // supabase login --token supports non-interactive auth
  // The token travels through `docker exec -e`, never inside the script text.
  // Interpolating it here is what let a token containing `$(...)` execute on the
  // host as root: JSON.stringify escapes quotes but not command substitution,
  // and execSync handed the result to the host shell before docker saw it.
  // "$SUPABASE_ACCESS_TOKEN" is expanded by the container's shell, which does
  // not re-parse the expanded value.
  await containerExec(
    container,
    'supabase login --token "$SUPABASE_ACCESS_TOKEN" --no-browser 2>&1',
    30000,
    { SUPABASE_ACCESS_TOKEN: accessToken.trim() },
  );
}

/**
 * Trello is delivered for the REST API, not for the CLI.
 *
 * The `trello` CLI stays in the base image and can still read a config of this
 * shape, but it is no longer required: the sync used to abort with "rebuild the
 * base image" when it was missing, over a tool nothing depends on. The agent is
 * told to call the API directly — see PROVIDER_ENTRIES and the Authentication
 * section that TOOLS.md carries.
 *
 * The file therefore lives under `~/.config/`, alongside Notion, rather than in
 * the CLI's own directory.
 */
async function deliverTrello(container: string, secret: Record<string, string>): Promise<void> {
  const { apiKey, token } = secret;
  if (!apiKey || !token) throw new Error('Missing Trello API key or token');

  const config = JSON.stringify({ apiKey, token });
  await containerExec(
    container,
    `mkdir -p /root/.config/trello && echo ${JSON.stringify(b64(config))} | base64 -d > /root/.config/trello/config.json && chmod 600 /root/.config/trello/config.json`,
  );
}

/** Notion: no CLI, just write a config file (same pattern as Trello). */
async function deliverNotion(container: string, secret: Record<string, string>): Promise<void> {
  const { token } = secret;
  if (!token) throw new Error('Missing Notion API token');

  const config = JSON.stringify({ token });
  await containerExec(
    container,
    `mkdir -p /root/.config/notion && echo ${JSON.stringify(b64(config))} | base64 -d > /root/.config/notion/config.json && chmod 600 /root/.config/notion/config.json`,
  );
}

// ── TOOLS.md managed section (per-container) ──────────────────────────────

const MARKER_START = '<!-- REV4A:INTEGRATIONS:START -->';
const MARKER_END = '<!-- REV4A:INTEGRATIONS:END -->';
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
    note: 'Trello REST API — boards, lists, cards. See Authentication below',
  },
  notion: {
    tool: 'notion',
    status: '✓ ready',
    note: 'Notion REST API — pages, databases, blocks. See Authentication below',
  },
};

/**
 * How to authenticate, for the providers with no CLI to do it for them.
 *
 * These are kept out of the table on purpose. A table cell is one line, and
 * these instructions have several steps — open a file, read named fields,
 * assemble a request. The field-name mismatch is the reason they exist at all:
 * the file Rev4a writes calls it `apiKey`, and Trello's API expects `key`.
 *
 * Only the entries for providers actually synced to a container are emitted, so
 * an agent with only CLI-backed credentials carries none of this.
 */
const AUTH_NOTES: Record<string, string> = {
  trello: [
    '**Trello** — read `~/.config/trello/config.json`: it holds `apiKey` and `token`.',
    'Pass them as query parameters, where `apiKey` becomes `key`:',
    '`https://api.trello.com/1/members/me?key=<apiKey>&token=<token>`',
  ].join('\n'),
  notion: [
    '**Notion** — read `~/.config/notion/config.json`: it holds `token`.',
    'Send `Authorization: Bearer <token>` and `Notion-Version: 2026-03-11` on every request.',
  ].join('\n'),
};

function entryRow(entry: IntegrationEntry): string {
  return `| \`${entry.tool}\` | ${entry.status} | ${entry.note} |`;
}

function buildBlock(integrations: IntegrationEntry[]): string {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  if (integrations.length === 0) {
    return `${MARKER_START}\n_No integrations configured via Rev4a._\n${MARKER_END}`;
  }

  const rows = integrations.map((e) => entryRow(e)).join('\n');
  // Emitted only for the providers present that need it; absent entirely when
  // every synced credential is CLI-backed.
  const notes = integrations.map((e) => AUTH_NOTES[e.tool]).filter(Boolean);
  const auth = notes.length ? `\n\n### Authentication\n\n${notes.join('\n\n')}` : '';
  return `${MARKER_START}
## Active Integrations

> Managed by Rev4a — do not edit this section manually. Last synced: ${ts}

| Tool | Status | Notes |
|---|---|---|
${rows}${auth}

${MARKER_END}`;
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
 * Write through a temporary file, then rename over the target.
 *
 * `> file` truncates before the first byte arrives, so an exec killed mid-write
 * leaves nothing behind — verified: a redirect interrupted after 1s left a 31
 * byte file at 0, while this form left it untouched. TOOLS.md carries the
 * agent's own instructions and is not regenerable, so the window matters here
 * even though it is small. `mv` on the same filesystem is atomic: the target is
 * either the old content or the new one, never a prefix of either.
 *
 * `lib/channelManager.ts` writes `openclaw.json` the same way.
 */
function writeAtomically(content: string, path: string): string {
  const tmp = `${path}.rev4a.tmp`;
  return `echo ${JSON.stringify(b64(content))} | base64 -d > ${tmp} && mv ${tmp} ${path}`;
}

/**
 * Add or remove a single provider's row from the TOOLS.md integration block
 * inside a single agent container (docker exec only, no host filesystem access).
 */
async function toggleProviderRow(
  container: string,
  providerId: string,
  action: 'add' | 'remove',
): Promise<void> {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  const entry = PROVIDER_ENTRIES[providerId];
  if (!entry) return;

  const existing = await containerRead(safe, TOOLS_MD_PATH);
  // A failed read must not lead to a write. It used to: '' meant both "empty"
  // and "unreadable", so a transient docker error sent the add path into its
  // "no block yet" branch, which writes the block plus `existing` — replacing
  // the whole of TOOLS.md with just the block.
  if (existing === null) return;
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
      await containerExec(safe, writeAtomically(newBlock + '\n' + existing, TOOLS_MD_PATH));
      return;
    }
  } else {
    // action === 'remove'
    if (si === -1 || ei === -1 || ei <= si) return; // No block to edit
    rows = extractRows(existing, si, ei).filter((r) => !r.includes(`\`${entry.tool}\``));
  }

  const newBlock = buildBlock(rowsToEntries(rows));
  const patched = existing.slice(0, si) + newBlock + existing.slice(ei + MARKER_END.length);
  await containerExec(safe, writeAtomically(patched, TOOLS_MD_PATH));
}

// ── Agent primitives — operate on ONE container ──────────────────────────

/**
 * Remove credentials for a specific provider from a single agent container.
 */
async function cleanProvider(container: string, providerId: string): Promise<void> {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  switch (providerId) {
    case 'github-pat':
      try { await containerExec(safe, 'rm -rf /root/.config/gh /root/.local/share/gh 2>/dev/null; exit 0', 10000); } catch {}
      break;
    case 'vercel':
      try { await containerExec(safe, 'rm -rf /root/.local/share/com.vercel.cli', 10000); } catch {}
      break;
    case 'supabase':
      try { await containerExec(safe, 'rm -f /root/.supabase/access-token 2>/dev/null; exit 0', 10000); } catch {}
      break;
    case 'trello':
      try { await containerExec(safe, 'rm -rf /root/.config/trello', 10000); } catch {}
      break;
    case 'notion':
      try { await containerExec(safe, 'rm -rf /root/.config/notion', 10000); } catch {}
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
    case 'github-pat': await deliverGithub(container, secret); break;
    case 'vercel':     await deliverVercel(container, secret); break;
    case 'supabase':   await deliverSupabase(container, secret); break;
    case 'trello':     await deliverTrello(container, secret); break;
    case 'notion':     await deliverNotion(container, secret); break;
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
  // Deduplicated: TOOLS.md is edited with a read-modify-write, so the same
  // container appearing twice would have two passes racing on one file. No
  // caller sends duplicates today — the UI always passes a single name and
  // `docker ps` names are unique — but the route forwards `body.containers`
  // unchecked, so nothing else stops it.
  const selectedTargets = [...new Set(containers ?? await listAgentContainers())]
    .map((c) => c.replace(/[^a-zA-Z0-9_.-]/g, ''))
    .filter(Boolean);

  // Three passes, kept sequential relative to each other: every target is
  // cleaned before any is delivered to, and TOOLS.md is only touched once the
  // outcome of every delivery is known. Within a pass the containers run
  // concurrently — each callback handles its own failures, because
  // mapWithConcurrency is fail-fast and one unreachable container would
  // otherwise discard the results already computed for the others.
  await mapWithConcurrency(selectedTargets, AGENT_WRITE_CONCURRENCY, async (container) => {
    try { await cleanProvider(container, providerId); } catch { /* best-effort, as before */ }
  });

  const results: SyncResult[] = await mapWithConcurrency(
    selectedTargets,
    AGENT_WRITE_CONCURRENCY,
    async (container): Promise<SyncResult> => {
      try {
        await deliverToAgent(container, providerId, secret);
        return { container, status: 'ok' };
      } catch (e: unknown) {
        return { container, status: 'error', error: (e as Error).message };
      }
    },
  );

  await mapWithConcurrency(selectedTargets, AGENT_WRITE_CONCURRENCY, async (container, i) => {
    const wasDelivered = results[i]?.status === 'ok';
    try {
      await toggleProviderRow(container, providerId, wasDelivered ? 'add' : 'remove');
    } catch { /* TOOLS.md is documentation; a failure here must not fail the sync */ }
  });

  return results;
}

/**
 * Clean a single provider from a single agent container and update its TOOLS.md.
 * Used by the De-sync button in the UI and by the sync endpoint for initial cleanup.
 */
export async function cleanAgentProviders(container: string, providerId: string): Promise<void> {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  await cleanProvider(safe, providerId);
  await toggleProviderRow(safe, providerId, 'remove');
}
