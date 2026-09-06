import { execFile } from 'child_process';
import { promisify } from 'util';
import { dockerExecShellNoFail } from '@/lib/docker-exec';
import { hashToken } from './hash';

const execFileAsync = promisify(execFile);

export interface AgentContainer {
  name: string;
  agentId: string;
}

/**
 * List running agent containers (those carrying an AGENT_ID label).
 * Shared by the detect API route and the credential delivery layer so both
 * reason over the exact same set of containers.
 */
export async function listAgentContainers(): Promise<AgentContainer[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}}\t{{.Label "AGENT_ID"}}'],
      { encoding: 'utf-8', timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, agentId] = line.split('\t');
      return { name: name ?? '', agentId: agentId ?? name ?? '' };
    });
  } catch (e: unknown) {
    throw new Error('listAgentContainers failed: ' + (e as Error).message);
  }
}

// ── Probing ─────────────────────────────────────────────────────────────────

/** Fields the probe script emits, in order. */
export interface ContainerProbe {
  cli: Record<'gh' | 'vercel' | 'supabase' | 'trello', boolean>;
  ghStatus: string;
  vercelWhoami: string;
  supabaseProjects: string;
  /** Exit status of `supabase projects list`. -1 when the probe never got there. */
  supabaseRc: number;
  agentName: string;
  toolsMdMarkers: number;
  /** Raw file contents, parsed by the caller. '' when absent or unreadable. */
  files: Record<
    'ghHosts' | 'vercelAuth' | 'vercelConfig' | 'supabaseToken' | 'supabaseConfig' | 'trelloConfig' | 'notionConfig',
    string
  >;
  /** False when the probe produced nothing at all — container gone, or it hung. */
  ok: boolean;
}

/**
 * One `docker exec` per container instead of twenty-one.
 *
 * Every probe used to be its own process, ~21 per container, each paying the
 * cost of starting `docker exec` — measured here at ~90ms, so roughly 1.9s of
 * pure process startup before any probe did work.
 *
 * The point of collapsing them is not the probe's own wall time. Measured on
 * Docker Desktop, this script costs ~6.5s per container, and ~6.4s of that is
 * the three CLI calls at the end reaching the network from inside the container
 * — which no amount of restructuring here makes faster. The gain is that the
 * twenty-one were `execSync`: each one blocked Node's single thread, so every
 * other request on the dashboard stopped for the duration. That is what this
 * removed. Compare figures only within one host; the network share dominates
 * and moves with the machine.
 *
 * Two properties of the script are load-bearing, and breaking either one loses
 * far more than it saves:
 *
 * - **No command may leave a non-zero status standing, and the script ends in
 *   `exit 0`.** `dockerExecShellNoFail` returns '' for the *entire* script on
 *   any non-zero exit, so a single command failing — and `gh auth status` exits
 *   non-zero simply when logged out — would discard all the other fields with
 *   it. Most commands satisfy this with a trailing `|| true`; `supabase
 *   projects list` instead assigns into a variable, which both neutralises the
 *   status and preserves it in `$?` for the caller to read.
 * - **NUL delimits the records.** A shell variable cannot hold a NUL byte, and
 *   none of the sources here (YAML, JSON, TOML, CLI stdout, ANSI escapes) emit
 *   one, so no value can forge a record boundary. This mirrors `readSkillsBulk`
 *   in `app/api/skills/route.js`, which has carried the same guarantee in
 *   production.
 *
 * What this does *not* preserve is per-probe timeout isolation: previously each
 * command had its own 10s budget, and now one hung CLI costs the whole
 * container's read. That is the deliberate trade — with `…NoFail` the damage
 * stops at that container instead of blanking the fleet.
 */
const PROBE_SCRIPT = [
  'k(){ printf "%s\\0" "$1"; }',
  'e(){ printf "\\0"; }',
  'for t in gh vercel supabase trello; do',
  '  k "cli:$t"; if command -v "$t" >/dev/null 2>&1; then printf yes; else printf no; fi; e',
  'done',
  // Local reads first. They are what decides whether a stored credential is
  // installed, and they cost nothing. The three CLI calls below reach the
  // network from inside the container and are the only plausible cause of a
  // timeout — putting them last means a truncated run loses only the "logged
  // in" niceties and keeps the token matching, instead of the other way round.
  'k file:ghHosts;       cat /root/.config/gh/hosts.yml 2>/dev/null || true; e',
  'k file:vercelAuth;    cat /root/.local/share/com.vercel.cli/auth.json 2>/dev/null || true; e',
  'k file:vercelConfig;  cat /root/.local/share/com.vercel.cli/config.json 2>/dev/null || true; e',
  'k file:supabaseToken; cat /root/.supabase/access-token 2>/dev/null || true; e',
  'k file:supabaseConfig; cat /data/supabase/config.toml 2>/dev/null || true; e',
  'k file:trelloConfig;  cat /root/.config/trello/config.json 2>/dev/null || true; e',
  'k file:notionConfig;  cat /root/.config/notion/config.json 2>/dev/null || true; e',
  'k agent:name;        printenv AGENT_NAME || true; e',
  'k tools:markers;     grep -c "REV4A:INTEGRATIONS:START" /root/.openclaw/workspace/TOOLS.md 2>/dev/null || true; e',
  // Sentinel, placed here rather than at the very end. A killed `docker exec`
  // does not necessarily reject: verified directly against a real container,
  // `dockerExecShellNoFail` resolves with whatever the script had already
  // printed when the process is killed for running past its timeout — so a
  // sentinel after the network calls discarded genuinely-captured local data
  // whenever only those calls hung. Putting it here means the token-matching
  // data survives a hang in any of the three CLI calls below; only their
  // "logged in as" niceties are lost, and every consumer of `ghStatus` /
  // `vercelWhoami` / `supabaseProjects` already treats an empty string as
  // "not logged in", not as a crash or a false positive.
  'k probe:complete;    printf ok; e',
  'k gh:status;         gh auth status 2>&1 || true; e',
  'k vercel:whoami;     vercel whoami 2>&1 || true; e',
  // Captured into a variable so the exit status survives: `|| true` discarded it,
  // and the only thing left to judge by was the text on stdout. Every failure
  // whose wording did not happen to contain "Unauthorized" — no token at all, a
  // container with no route to the network — then read as a successful listing,
  // and the agent was reported as logged in to Supabase when it held nothing.
  'sbout=$(supabase projects list --output json 2>&1); sbrc=$?',
  'k supabase:projects; printf %s "$sbout"; e',
  'k supabase:rc;       printf %s "$sbrc"; e',
  'exit 0',
].join('\n');

const EMPTY_PROBE: ContainerProbe = {
  cli: { gh: false, vercel: false, supabase: false, trello: false },
  ghStatus: '', vercelWhoami: '', supabaseProjects: '', supabaseRc: -1, agentName: '',
  toolsMdMarkers: 0,
  files: {
    ghHosts: '', vercelAuth: '', vercelConfig: '',
    supabaseToken: '', supabaseConfig: '', trelloConfig: '', notionConfig: '',
  },
  ok: false,
};

export async function probeContainer(container: string): Promise<ContainerProbe> {
  const raw = await dockerExecShellNoFail(container, PROBE_SCRIPT, {
    timeoutMs: 25_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!raw) return { ...EMPTY_PROBE, files: { ...EMPTY_PROBE.files }, cli: { ...EMPTY_PROBE.cli } };

  const parts = raw.split('\0');
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i], parts[i + 1]);

  const g = (k: string) => map.get(k) ?? '';
  if (g('probe:complete').trim() !== 'ok') {
    return { ...EMPTY_PROBE, files: { ...EMPTY_PROBE.files }, cli: { ...EMPTY_PROBE.cli } };
  }
  return {
    cli: {
      gh: g('cli:gh').trim() === 'yes',
      vercel: g('cli:vercel').trim() === 'yes',
      supabase: g('cli:supabase').trim() === 'yes',
      trello: g('cli:trello').trim() === 'yes',
    },
    ghStatus: g('gh:status'),
    vercelWhoami: g('vercel:whoami'),
    supabaseProjects: g('supabase:projects'),
    // A hang in the call kills the script before either key is emitted, so an
    // unparseable status has to mean failure — never success by default.
    supabaseRc: /^\d+$/.test(g('supabase:rc').trim()) ? parseInt(g('supabase:rc').trim(), 10) : -1,
    agentName: g('agent:name').trim(),
    toolsMdMarkers: parseInt(g('tools:markers').trim(), 10) || 0,
    files: {
      ghHosts: g('file:ghHosts'),
      vercelAuth: g('file:vercelAuth'),
      vercelConfig: g('file:vercelConfig'),
      supabaseToken: g('file:supabaseToken'),
      supabaseConfig: g('file:supabaseConfig'),
      trelloConfig: g('file:trelloConfig'),
      notionConfig: g('file:notionConfig'),
    },
    ok: true,
  };
}

// ── Token extraction, in JavaScript ─────────────────────────────────────────

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

function jsonField(raw: string, key: string): string {
  if (!raw.trim()) return '';
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** `oauth_token:` out of gh's hosts.yml. Two levels deep, so no YAML parser. */
function ghToken(raw: string): string {
  for (const line of raw.split('\n')) {
    const m = /^\s*oauth_token:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return '';
}

/**
 * `project_id` out of supabase's config.toml.
 *
 * This replaces a `sed` expression that never worked. It was written inside a
 * single-quoted JS string using backslash-escaped double quotes, which in
 * JavaScript collapse to bare quotes; those closed the shell's quoting early, so
 * the semicolon separating the two substitutions was read as a command
 * separator and the shell tried to execute the second one as a program. Every
 * detection logged `sh: 1: not found` for it, and the field came back empty.
 */
function tomlProjectId(raw: string): string {
  for (const line of raw.split('\n')) {
    const m = /^\s*project_id\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1];
  }
  return '';
}

/**
 * Vercel's `currentTeam`.
 *
 * The previous `sed 's/.*: *"//'` was greedy: on a single line holding several
 * key/value pairs it matched up to the *last* `": "` and returned whichever
 * value came after, not currentTeam's. It went unnoticed only because the real
 * config.json happens to be pretty-printed — correctness resting on a third
 * party's formatting choice.
 */
export function extractInstalledToken(probe: ContainerProbe, providerId: string): string {
  switch (providerId) {
    case 'github-pat': return ghToken(probe.files.ghHosts);
    case 'vercel':     return jsonField(probe.files.vercelAuth, 'token');
    case 'supabase':   return probe.files.supabaseToken.split('\n')[0]?.trim() ?? '';
    case 'trello':     return jsonField(probe.files.trelloConfig, 'token');
    case 'notion':     return jsonField(probe.files.notionConfig, 'token');
    default:           return '';
  }
}

/** Hash of the token currently installed for a provider ('' when unreadable). */
export function providerTokenHash(probe: ContainerProbe, providerId: string): string {
  const raw = extractInstalledToken(probe, providerId);
  if (!raw || raw.length < 10) return '';
  return hashToken(raw);
}

export function vercelCurrentTeam(probe: ContainerProbe): string {
  return jsonField(probe.files.vercelConfig, 'currentTeam');
}

export function supabaseProjectRef(probe: ContainerProbe): string {
  return tomlProjectId(probe.files.supabaseConfig);
}
