import { NextResponse, type NextRequest } from 'next/server';
import { listProfiles, getSecret } from '@/lib/credentials/vault';
import {
  listAgentContainers,
  probeContainer,
  profileTokenHash,
  vercelCurrentTeam,
  supabaseProjectRef,
  detectHoldings,
  resolveCredentials,
  type ContainerProbe,
  type DetectedCredential,
} from '@/lib/credentials/detect';
import { agentUsesCodex } from '@/lib/credentials/runtime';
import { mapWithConcurrency } from '@/lib/docker-exec';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
  /** Legacy trello-cli probe; false on the 2026.9.9 image, whose bundled skill uses curl and jq. */
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
  /**
   * What the container really holds, per provider, by every delivery method (secret store,
   * managed GitHub identity, Vercel files, an older release's files). The page's switch state.
   * Hashes are compared inside this route; no token value is ever returned. `present` is null
   * where the container could not be read for that provider (never guessed as "holds nothing").
   */
  credentials: DetectedCredential[];
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

function shape(container: string, agentId: string, probe: ContainerProbe, profiles: HashedProfile[], codex: boolean): DetectedStatus {
  const credentials = resolveCredentials(detectHoldings(probe), profiles, probe.digests);
  const held = (providerId: string) => credentials.find((c) => c.providerId === providerId);
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
    githubLoggedIn: githubLoggedIn || !!held('github-pat')?.present,
    githubUser: ghMatch?.[1] ?? held('github-pat')?.login ?? '',
    githubCliInstalled: probe.cli.gh,
    vercelLoggedIn,
    vercelUser: vercelLoggedIn ? extractUsername(probe.vercelWhoami) : '',
    vercelTeam: vercelLoggedIn ? vercelCurrentTeam(probe) : '',
    vercelCliInstalled: probe.cli.vercel,
    supabaseLoggedIn,
    supabaseLinked: !!projectRef,
    supabaseProjectRef: projectRef,
    supabaseCliInstalled: probe.cli.supabase,
    // Neither ships a status command: a credential in the secret store or in the config file an
    // earlier release wrote is what "logged in" means here.
    trelloLoggedIn: !!held('trello')?.present,
    trelloCliInstalled: probe.cli.trello,
    notionLoggedIn: !!held('notion')?.present,
    codex,
    toolsMdHasMarkers: probe.toolsMdMarkers > 0,
    matchedProfiles: profiles
      .filter((p) => credentials.some((c) => c.profileIds.includes(p.profileId)))
      .map(({ profileId, providerId, label }) => ({ profileId, providerId, label })),
    installedProviders: credentials.filter((c) => c.present === true).map((c) => c.providerId),
    credentials,
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
