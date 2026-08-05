import { NextResponse, type NextRequest } from 'next/server';
import { listProfiles, getSecret } from '@/lib/credentials/vault';
import {
  listAgentContainers,
  execInContainer,
  cliInstalled,
  providerTokenHash,
  profileTokenHash,
  detectTrello,
  detectNotion,
} from '@/lib/credentials/detect';

export const dynamic = 'force-dynamic';

interface DetectedStatus {
  container: string;
  agentId: string;
  displayName?: string;
  githubLoggedIn: boolean;
  githubUser: string;
  githubCliInstalled: boolean;
  vercelLoggedIn: boolean;
  vercelUser: string;
  vercelTeam: string;
  vercelCliInstalled: boolean;
  supabaseLoggedIn: boolean;
  supabaseLinked: boolean;
  supabaseProjectRef: string;
  supabaseCliInstalled: boolean;
  trelloLoggedIn: boolean;
  trelloCliInstalled: boolean;
  notionLoggedIn: boolean;
  toolsMdHasMarkers: boolean;
  matchedProfiles: { profileId: string; providerId: string; label: string }[];
}

interface DetectionError {
  container: string;
  agentId: string;
  error: string;
}

function detectSupabase(container: string): { loggedIn: boolean; linked: boolean; projectRef: string } {
  if (!cliInstalled(container, 'supabase')) {
    return { loggedIn: false, linked: false, projectRef: '' };
  }

  // Verify login by calling the Supabase API (analogous to gh auth status / vercel whoami)
  const raw = execInContainer(
    container,
    'supabase projects list --output json 2>&1',
    (r) => r.trim(),
    '',
  );

  // Unauthorized → not logged in
  if (!raw || raw.includes('Unauthorized')) {
    return { loggedIn: false, linked: false, projectRef: '' };
  }

  // Check if a linked project exists in the workspace
  let linked = false;
  let projectRef = '';
  const linkedRef = execInContainer(
    container,
    'cat /data/supabase/config.toml 2>/dev/null | grep project_id | head -1 | sed "s/.*= *\"//;s/\".*//"',
    (r) => r.trim(),
    '',
  );
  if (linkedRef && linkedRef.length > 0) {
    linked = true;
    projectRef = linkedRef;
  }

  return { loggedIn: true, linked, projectRef };
}

function detectGithub(container: string): { loggedIn: boolean; user: string } {
  if (!cliInstalled(container, 'gh')) {
    return { loggedIn: false, user: '' };
  }

  const raw = execInContainer(
    container,
    'gh auth status 2>&1',
    (r) => r,
    '',
  );
  if (!raw || raw.includes('not logged into any GitHub hosts')) {
    return { loggedIn: false, user: '' };
  }
  const match = raw.match(/Logged in to github\.com as (\S+)/);
  return { loggedIn: !!match, user: match?.[1] ?? '' };
}

function detectToolsMd(container: string): boolean {
  const raw = execInContainer(
    container,
    `grep -c 'REV4A:INTEGRATIONS:START' /root/.openclaw/workspace/TOOLS.md 2>/dev/null || echo 0`,
    (r) => r.trim(),
    '0',
  );
  return raw === '1' || parseInt(raw, 10) > 0;
}

function detectVercel(container: string): { loggedIn: boolean; user: string; team: string } {
  if (!cliInstalled(container, 'vercel')) {
    return { loggedIn: false, user: '', team: '' };
  }

  const whoami = execInContainer(
    container,
    'vercel whoami 2>&1 || true',
    (r) => r.trim(),
    '',
  );
  if (whoami && !whoami.includes('Error:') && !whoami.includes('Not authorized')) {
    const teamRaw = execInContainer(
      container,
      "cat /root/.local/share/com.vercel.cli/config.json 2>/dev/null | grep 'currentTeam' | head -1 | sed 's/.*: *\"//;s/\".*//'",
      (r) => r.trim(),
      '',
    );
    return { loggedIn: true, user: extractUsername(whoami), team: teamRaw };
  }

  return { loggedIn: false, user: '', team: '' };
}

/**
 * Extract just the username from 'vercel whoami' output (strip header lines).
 */
function extractUsername(raw: string): string {
  const lines = raw.split('\n').filter(Boolean);
  // Return the last non-empty line (the actual username)
  return lines[lines.length - 1]?.trim() || raw;
}

/**
 * Match detected state to stored credential profiles by comparing token hashes.
 * `hashes` maps a providerId to the hash of the token currently installed in the
 * container. A profile matches when its own token hashes to the same value.
 * Providers whose token cannot be read yield '' and therefore never match.
 */
function matchProfiles(
  hashes: Record<string, string>,
): { profileId: string; providerId: string; label: string }[] {
  const profiles = listProfiles();
  const matched: { profileId: string; providerId: string; label: string }[] = [];

  for (const profile of profiles) {
    const installedHash = hashes[profile.providerId];
    if (!installedHash) continue;

    const storedHash = profileTokenHash(getSecret(profile.id), profile.providerId);
    if (storedHash && storedHash === installedHash) {
      matched.push({ profileId: profile.id, providerId: profile.providerId, label: profile.label });
    }
  }

  return matched;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const filterAgent = url.searchParams.get('agent');
    let containers = listAgentContainers();

    if (filterAgent) {
      containers = containers.filter((c) => c.name === filterAgent);
      if (containers.length === 0) {
        return NextResponse.json({ error: `Agent "${filterAgent}" not found` }, { status: 404 });
      }
    }

    const results: (DetectedStatus | DetectionError)[] = [];

    for (const { name, agentId } of containers) {
      try {
        const { loggedIn: githubLoggedIn, user: githubUser } = detectGithub(name);
        const { loggedIn: trelloLoggedIn } = detectTrello(name);
        const { loggedIn: notionLoggedIn } = detectNotion(name);
        const { loggedIn: vercelLoggedIn, user: vercelUser, team: vercelTeam } = detectVercel(name);
        const { loggedIn: supabaseLoggedIn, linked: supabaseLinked, projectRef: supabaseProjectRef } = detectSupabase(name);

        const githubCliInstalled = cliInstalled(name, 'gh');
        const vercelCliInstalled = cliInstalled(name, 'vercel');
        const supabaseCliInstalled = cliInstalled(name, 'supabase');
        const trelloCliInstalled = cliInstalled(name, 'trello');
        const toolsMdHasMarkers = detectToolsMd(name);

        // Read AGENT_NAME env for display name (may differ from container name)
        const displayName = execInContainer(
          name,
          'printenv AGENT_NAME',
          (r) => r.trim(),
          '',
        ) || undefined;

        // Precise profile matching by token hash — one source of truth for all providers.
        const matchedProfiles = matchProfiles({
          'github-pat': providerTokenHash(name, 'github-pat'),
          vercel: providerTokenHash(name, 'vercel'),
          supabase: providerTokenHash(name, 'supabase'),
          trello: providerTokenHash(name, 'trello'),
          notion: providerTokenHash(name, 'notion'),
        });

        results.push({
          container: name,
          agentId,
          displayName,
          githubLoggedIn,
          githubUser,
          githubCliInstalled,
          vercelLoggedIn,
          vercelUser,
          vercelTeam,
          vercelCliInstalled,
          supabaseLoggedIn,
          supabaseLinked,
          supabaseProjectRef,
          supabaseCliInstalled,
          trelloLoggedIn,
          trelloCliInstalled,
          notionLoggedIn,
          toolsMdHasMarkers,
          matchedProfiles,
        });
      } catch (e: unknown) {
        results.push({
          container: name,
          agentId,
          error: (e as Error).message,
        });
      }
    }

    return NextResponse.json({ agents: results });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
