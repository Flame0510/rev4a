import { NextResponse, type NextRequest } from 'next/server';
import { listProfiles, getSecret } from '@/lib/credentials/vault';
import {
  listAgentContainers,
  probeContainer,
  providerTokenHash,
  profileTokenHash,
  vercelCurrentTeam,
  supabaseProjectRef,
  TOKEN_FIELD,
  type ContainerProbe,
} from '@/lib/credentials/detect';
import { agentUsesCodex } from '@/lib/credentials/runtime';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

/** Containers probed at once. Each is a single `docker exec`. */
const AGENT_QUERY_CONCURRENCY = 6;

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
  /** The default model runs on the ChatGPT (Codex) runtime: env entries reach only OpenClaw-run commands. */
  codex: boolean;
  toolsMdHasMarkers: boolean;
  matchedProfiles: { profileId: string; providerId: string; label: string }[];
  /**
   * Providers with a token present in the container, whether or not it belongs
   * to a stored profile. A provider listed here but absent from
   * `matchedProfiles` holds a credential nobody in the vault accounts for.
   */
  installedProviders: string[];
}

interface DetectionError {
  container: string;
  agentId: string;
  error: string;
}

/** Last non-empty line of `vercel whoami` — the rest is header noise. */
function extractUsername(raw: string): string {
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() || raw.trim();
}

/**
 * Stored profiles with their token hashes, computed once per request.
 *
 * This used to run inside the per-container loop: `listProfiles()` plus one
 * `getSecret()` per profile, each opening its own SQLite connection, repeated
 * for every agent. Nothing in it depends on the container, so it is hoisted.
 */
interface HashedProfile {
  profileId: string;
  providerId: string;
  label: string;
  tokenHash: string;
}

function loadHashedProfiles(): HashedProfile[] {
  return listProfiles()
    .map((p) => ({
      profileId: p.id,
      providerId: p.providerId,
      label: p.label,
      tokenHash: profileTokenHash(getSecret(p.id), p.providerId),
    }))
    .filter((p) => p.tokenHash);
}

/**
 * Hash of whatever token each provider currently has installed in the container.
 *
 * Computed for every provider, not only those with a stored profile. The probe
 * has already fetched all of these files in its single exec, so the extra work
 * is a handful of SHA-256 over short strings — and restricting it would hide the
 * case that matters most: a token present in the container that matches nothing
 * in the vault, which is what a credential edited after syncing looks like.
 */
function installedHashes(probe: ContainerProbe): Map<string, string> {
  const out = new Map<string, string>();
  for (const providerId of Object.keys(TOKEN_FIELD)) {
    const h = providerTokenHash(probe, providerId);
    if (h) out.set(providerId, h);
  }
  return out;
}

function matchProfiles(installed: Map<string, string>, profiles: HashedProfile[]) {
  return profiles
    .filter((p) => installed.get(p.providerId) === p.tokenHash)
    .map(({ profileId, providerId, label }) => ({ profileId, providerId, label }));
}

function shape(container: string, agentId: string, probe: ContainerProbe, profiles: HashedProfile[], codex: boolean): DetectedStatus {
  const installed = installedHashes(probe);
  // `gh` changed the wording: 2.97 prints "…github.com account <user>", older
  // builds print "…as <user>". The image installs it unpinned from apt, so both
  // are accepted rather than tracking whichever one ships today.
  const ghMatch = /Logged in to github\.com (?:as|account) (\S+)/.exec(probe.ghStatus);
  const githubLoggedIn =
    probe.cli.gh && !probe.ghStatus.includes('not logged into any GitHub hosts') && !!ghMatch;

  const whoami = probe.vercelWhoami.trim();
  const vercelLoggedIn =
    probe.cli.vercel && !!whoami && !whoami.includes('Error:') && !whoami.includes('Not authorized');

  const projects = probe.supabaseProjects.trim();
  // The exit status is the signal, not the wording. Matching on 'Unauthorized'
  // recognised only the one failure whose text happened to say so; a missing
  // token and an unreachable network both printed something else and passed.
  const supabaseLoggedIn = probe.cli.supabase && probe.supabaseRc === 0 && !!projects;
  const projectRef = supabaseLoggedIn ? supabaseProjectRef(probe) : '';

  return {
    container,
    agentId,
    displayName: probe.agentName || undefined,
    githubLoggedIn,
    githubUser: ghMatch?.[1] ?? '',
    githubCliInstalled: probe.cli.gh,
    vercelLoggedIn,
    vercelUser: vercelLoggedIn ? extractUsername(probe.vercelWhoami) : '',
    vercelTeam: vercelLoggedIn ? vercelCurrentTeam(probe) : '',
    vercelCliInstalled: probe.cli.vercel,
    supabaseLoggedIn,
    supabaseLinked: !!projectRef,
    supabaseProjectRef: projectRef,
    supabaseCliInstalled: probe.cli.supabase,
    // Old-way signal only: presence of the config file written by earlier releases. A natively
    // delivered credential leaves no file; its state comes from the assignments, not from here.
    // Presence of the config file is the login signal for both — neither ships a
    // status command. An empty file now counts as absent, where `test -f` used
    // to accept it.
    trelloLoggedIn: !!probe.files.trelloConfig.trim(),
    trelloCliInstalled: probe.cli.trello,
    notionLoggedIn: !!probe.files.notionConfig.trim(),
    codex,
    toolsMdHasMarkers: probe.toolsMdMarkers > 0,
    matchedProfiles: matchProfiles(installed, profiles),
    installedProviders: [...installed.keys()],
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const url = new URL(request.url);
    const filterAgent = url.searchParams.get('agent');

    let containers = await listAgentContainers();
    if (filterAgent) {
      containers = containers.filter((c) => c.name === filterAgent);
      if (containers.length === 0) {
        return NextResponse.json({ error: `Agent "${filterAgent}" not found` }, { status: 404 });
      }
    }

    const profiles = loadHashedProfiles();

    // The callback swallows its own failures: mapWithConcurrency is fail-fast,
    // so letting one unreachable container reject would discard the results
    // already computed for every other agent.
    const agents = await mapWithConcurrency<{ name: string; agentId: string }, DetectedStatus | DetectionError>(
      containers,
      AGENT_QUERY_CONCURRENCY,
      async ({ name, agentId }) => {
        try {
          const [probe, codex] = await Promise.all([probeContainer(name), agentUsesCodex(name)]);
          if (!probe.ok) {
            return { container: name, agentId, error: 'Container did not respond' };
          }
          return shape(name, agentId, probe, profiles, codex);
        } catch (e: unknown) {
          return { container: name, agentId, error: (e as Error).message };
        }
      },
    );

    return NextResponse.json({ agents });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
