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

/** Hashes the in-container script reports. Every hash is '' when there is no (usable) token. */
export interface ProbeDigests {
  /** Secret-store entries: name, kind, hash of the stored value. */
  store: { name: string; kind: string; hash: string }[];
  /** `agents.entries.main.tools.github.profileId` of the managed GitHub identity ('' when none). */
  githubProfileId: string;
  /** True when that profile's own hosts.yml exists. A profile id with no hosts.yml cannot authenticate. */
  ghIdentityFound: boolean;
  ghIdentity: { hash: string; login: string };
  ghLegacy: { hash: string; login: string };
  vercel: string;
  supabaseLegacy: string;
  trelloLegacy: string;
  notionLegacy: string;
  /** The secret store was read successfully (an empty store counts). False: its absence is unknown. */
  storeOk: boolean;
  /** The script ran to its last line. False: nothing it printed proves anything. */
  digestOk: boolean;
}

const EMPTY_DIGESTS: ProbeDigests = {
  store: [], githubProfileId: '', ghIdentityFound: false,
  ghIdentity: { hash: '', login: '' }, ghLegacy: { hash: '', login: '' },
  vercel: '', supabaseLegacy: '', trelloLegacy: '', notionLegacy: '',
  storeOk: false, digestOk: false,
};

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
  /**
   * Token hashes computed INSIDE the container by {@link DIGEST_SCRIPT}. No raw token is ever
   * in the probe output: OpenClaw masks some values in `secrets store list`, and a value that
   * leaves the container is a value that can leak.
   */
  digests: ProbeDigests;
  /** Non-secret files, parsed by the caller. '' when absent or unreadable. */
  files: Record<'vercelConfig' | 'supabaseConfig', string>;
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
/**
 * Runs inside the agent (node is in the image) and prints one tab-separated line per finding,
 * hashes only: `store<TAB>NAME<TAB>kind<TAB>hash`, `gh-profile<TAB>id`, `gh-identity<TAB>hash<TAB>login`,
 * `gh-legacy`, `vercel`, `supabase-legacy`, `trello-legacy`, `notion-legacy`, plus two completion
 * markers: `store-ok` after the secret store was read (including an older database without the
 * table; a locked or corrupt database or a missing node:sqlite prints none) and `digest-ok` as the
 * last line (the script ran to its end). The hash is exactly
 * hashToken (lib/credentials/hash.ts): sha256 of the trimmed value, first 12 hex characters. A value
 * trimmed empty string counts as no token. It is read from the sources, not from the OpenClaw
 * CLI, which masks some values. A missing database or table prints `store-ok`. The text holds no
 * single quote (it sits inside a shell single-quoted argument) and no interpolation.
 *
 * The secret store is table secret_store_entries of /root/.openclaw/state/openclaw.sqlite.
 * The managed GitHub identity lives in
 * /root/.openclaw/credentials/github/agents/<agent hash>/<profileId>/hosts.yml; only the directory named
 * like `agents.entries.main.tools.github.profileId` (from the parsed JSON, not a pattern) is read, because retired profiles linger until the Gateway restarts.
 */
export const DIGEST_SCRIPT = [
  'const fs=require("fs"),c=require("crypto");',
  'const h=v=>{if(typeof v!=="string")return "";v=v.trim();return v?c.createHash("sha256").update(v,"utf-8").digest("hex").slice(0,12):""};',
  'const rd=f=>{try{return fs.readFileSync(f,"utf8")}catch(e){return ""}};',
  'const js=f=>{try{return JSON.parse(rd(f))}catch(e){return {}}};',
  'const cl=v=>String(v==null?"":v).replace(/[\\t\\r\\n]/g," ");',
  'const out=[];const o=(...a)=>out.push(a.map(cl).join("\\t"));',
  'const uq=v=>{const m=/^(["\\x27])(.*)\\1$/.exec(v);return m?m[2]:v};',
  'const yml=t=>{let k="",u="",m;for(const l of t.split("\\n")){if(!k&&(m=/^\\s*oauth_token:\\s*(.+?)\\s*$/.exec(l)))k=uq(m[1]);if(!u&&(m=/^\\s*user:\\s*(\\S+)\\s*$/.exec(l)))u=uq(m[1])}return [h(k),u]};',
  'try{if(!fs.existsSync("/root/.openclaw/state/openclaw.sqlite"))o("store-ok");else{const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/root/.openclaw/state/openclaw.sqlite",{readOnly:true});',
  'try{const t=d.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table","secret_store_entries");if(t)for(const r of d.prepare("SELECT name,value,kind FROM secret_store_entries WHERE deleted_at_ms IS NULL").all())o("store",r.name,r.kind,h(r.value));o("store-ok")}finally{d.close()}}}catch(e){}',
  'try{const g=js("/root/.openclaw/openclaw.json");const p=g&&g.agents&&g.agents.entries&&g.agents.entries.main&&g.agents.entries.main.tools&&g.agents.entries.main.tools.github&&g.agents.entries.main.tools.github.profileId;const pid=typeof p==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(p)?p:"";if(pid){o("gh-profile",pid);',
  'const b="/root/.openclaw/credentials/github/agents/";for(const x of fs.readdirSync(b)){const t=rd(b+x+"/"+pid+"/hosts.yml");if(t){const [k,u]=yml(t);o("gh-identity",k,u);break}}}}catch(e){}',
  'try{const [k,u]=yml(rd("/root/.config/gh/hosts.yml"));if(k)o("gh-legacy",k,u)}catch(e){}',
  'o("vercel",h(js("/root/.local/share/com.vercel.cli/auth.json").token));',
  'o("supabase-legacy",h(rd("/root/.supabase/access-token").split("\\n")[0]));',
  'o("trello-legacy",h(js("/root/.config/trello/config.json").token));',
  'o("notion-legacy",h(js("/root/.config/notion/config.json").token));',
  'o("digest-ok");',
  'process.stdout.write(out.join("\\n"))',
].join('');

export const PROBE_SCRIPT = [
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
  'k file:vercelConfig;  cat /root/.local/share/com.vercel.cli/config.json 2>/dev/null || true; e',
  'k file:supabaseConfig; cat /data/supabase/config.toml 2>/dev/null || true; e',
  // Every token hash, computed inside the container (see DIGEST_SCRIPT): the secret store, the
  // managed GitHub identity, the Vercel files and the files earlier releases wrote.
  `k digests;           node -e '${DIGEST_SCRIPT}' 2>/dev/null || true; e`,
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
  // The exit status is emitted with the text ("rc=<n>" on a last line): a logged-out CLI
  // prints a hint on stdout and, depending on its version, exits 0 or not, so the text
  // alone read as a username (see parseVercelWhoami).
  'k vercel:whoami;     vwout=$(vercel whoami 2>&1); vwrc=$?; printf "%s\\nrc=%s" "$vwout" "$vwrc"; e',
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

/**
 * The signed-in Vercel username out of the probe's `vercel whoami` record, or ''.
 *
 * The record is the CLI's output followed by a line `rc=<exit status>`. It counts only when
 * the status is 0 and the output is a plain username: one line, no spaces, and not one of the
 * messages the CLI prints around a failure. A logged-out CLI printed
 * "> Run `vercel deploy --temporary` to create a temporary deployment you can claim later, or
 * `vercel login` to log in." and that text used to be reported as the user.
 */
export function parseVercelWhoami(record: string): string {
  const lines = record.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n');
  const last = (lines.pop() ?? '').trim();
  const m = /^rc=(\d+)$/.exec(last);
  if (!m || m[1] !== '0') return '';
  const out = lines.join('\n').trim();
  if (!out || out.includes('\n') || /\s/.test(out)) return '';
  if (out.startsWith('>') || /^(Error|Vercel CLI)/i.test(out)) return '';
  return out;
}

const EMPTY_PROBE: ContainerProbe = {
  cli: { gh: false, vercel: false, supabase: false, trello: false },
  ghStatus: '', vercelWhoami: '', supabaseProjects: '', supabaseRc: -1, agentName: '',
  toolsMdMarkers: 0, digests: EMPTY_DIGESTS,
  files: { vercelConfig: '', supabaseConfig: '' },
  ok: false,
};

function emptyProbe(): ContainerProbe {
  return { ...EMPTY_PROBE, digests: parseDigests(''), files: { ...EMPTY_PROBE.files }, cli: { ...EMPTY_PROBE.cli } };
}

const HASH_RE = /^[0-9a-f]{12}$/;
const hashOrEmpty = (v: string | undefined): string => (v && HASH_RE.test(v) ? v : '');

/** Parse {@link DIGEST_SCRIPT}'s output. Anything that is not a 12-hex hash counts as no token. */
export function parseDigests(raw: string): ProbeDigests {
  const d: ProbeDigests = {
    ...EMPTY_DIGESTS, store: [], ghIdentity: { hash: '', login: '' }, ghLegacy: { hash: '', login: '' },
  };
  const login = (v: string | undefined) => (v && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v) ? v : '');
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const [kind, a, b, c] = line.split('\t');
    switch (kind) {
      case 'store': if (a) d.store.push({ name: a, kind: b ?? '', hash: hashOrEmpty(c) }); break;
      case 'gh-profile': d.githubProfileId = /^[A-Za-z0-9_-]{1,80}$/.test(a ?? '') ? a : ''; break;
      case 'store-ok': d.storeOk = true; break;
      case 'digest-ok': d.digestOk = true; break;
      case 'gh-identity': d.ghIdentityFound = true; d.ghIdentity = { hash: hashOrEmpty(a), login: login(b) }; break;
      case 'gh-legacy': d.ghLegacy = { hash: hashOrEmpty(a), login: login(b) }; break;
      case 'vercel': d.vercel = hashOrEmpty(a); break;
      case 'supabase-legacy': d.supabaseLegacy = hashOrEmpty(a); break;
      case 'trello-legacy': d.trelloLegacy = hashOrEmpty(a); break;
      case 'notion-legacy': d.notionLegacy = hashOrEmpty(a); break;
    }
  }
  return d;
}

export async function probeContainer(container: string): Promise<ContainerProbe> {
  const raw = await dockerExecShellNoFail(container, PROBE_SCRIPT, {
    timeoutMs: 25_000,
    partialOnTimeout: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseProbeOutput(raw);
}

/** Parse the probe's NUL-delimited records. Pure: the tests feed it sample output. */
export function parseProbeOutput(raw: string): ContainerProbe {
  if (!raw) return emptyProbe();

  const parts = raw.split('\0');
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i], parts[i + 1]);

  const g = (k: string) => map.get(k) ?? '';
  if (g('probe:complete').trim() !== 'ok') {
    return emptyProbe();
  }
  return {
    cli: {
      gh: g('cli:gh').trim() === 'yes',
      vercel: g('cli:vercel').trim() === 'yes',
      supabase: g('cli:supabase').trim() === 'yes',
      trello: g('cli:trello').trim() === 'yes',
    },
    ghStatus: g('gh:status'),
    vercelWhoami: parseVercelWhoami(g('vercel:whoami')),
    supabaseProjects: g('supabase:projects'),
    // A hang in the call kills the script before either key is emitted, so an
    // unparseable status has to mean failure — never success by default.
    supabaseRc: /^\d+$/.test(g('supabase:rc').trim()) ? parseInt(g('supabase:rc').trim(), 10) : -1,
    agentName: g('agent:name').trim(),
    toolsMdMarkers: parseInt(g('tools:markers').trim(), 10) || 0,
    digests: parseDigests(g('digests')),
    files: {
      vercelConfig: g('file:vercelConfig'),
      supabaseConfig: g('file:supabaseConfig'),
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

/** Vercel's `currentTeam`, from the non-secret config.json. */
export function vercelCurrentTeam(probe: ContainerProbe): string {
  return jsonField(probe.files.vercelConfig, 'currentTeam');
}

export function supabaseProjectRef(probe: ContainerProbe): string {
  return tomlProjectId(probe.files.supabaseConfig);
}

// ── What each container really holds, by every delivery method ─────────────

/** How a credential reached the agent. `store` and `github-identity`/`vercel-files` are current; `legacy-files` is an older release's. */
export type DetectMethod = 'store' | 'github-identity' | 'vercel-files' | 'legacy-files';

/** The secret-store entry whose value identifies each provider's credential (same field as {@link TOKEN_FIELD}). */
const STORE_ENTRY: Record<string, string> = {
  supabase: 'SUPABASE_ACCESS_TOKEN',
  trello: 'TRELLO_TOKEN',
  notion: 'NOTION_API_TOKEN',
};

/** What the agent holds for one provider. Carries a hash, never the token. */
export interface Holding {
  providerId: string;
  method: DetectMethod;
  /** Hash of the token; '' when the credential is there but its token could not be read. */
  tokenHash: string;
  login?: string;
}

/** One holding per provider the container has a credential for, by whichever method delivered it. */
export function detectHoldings(probe: ContainerProbe): Holding[] {
  const dg = probe.digests;
  const out: Holding[] = [];

  // GitHub: the managed identity first, then the old hosts.yml. A profile id with no hosts.yml of its
  // own cannot authenticate: it is not a credential, and it hides the old file it replaced.
  if (dg.githubProfileId) {
    if (dg.ghIdentityFound) out.push({ providerId: 'github-pat', method: 'github-identity', tokenHash: dg.ghIdentity.hash, ...(dg.ghIdentity.login ? { login: dg.ghIdentity.login } : {}) });
  } else if (dg.ghLegacy.hash) {
    out.push({ providerId: 'github-pat', method: 'legacy-files', tokenHash: dg.ghLegacy.hash, ...(dg.ghLegacy.login ? { login: dg.ghLegacy.login } : {}) });
  }

  // Vercel: the CLI's own files are the current delivery.
  if (dg.vercel) out.push({ providerId: 'vercel', method: 'vercel-files', tokenHash: dg.vercel });

  // Supabase, Trello, Notion: the secret store, else the files an older release wrote.
  const legacy: Record<string, string> = { supabase: dg.supabaseLegacy, trello: dg.trelloLegacy, notion: dg.notionLegacy };
  for (const providerId of Object.keys(STORE_ENTRY)) {
    const entry = dg.store.find((e) => e.name === STORE_ENTRY[providerId] && e.kind === 'env' && e.hash);
    if (entry) out.push({ providerId, method: 'store', tokenHash: entry.hash });
    else if (legacy[providerId]) out.push({ providerId, method: 'legacy-files', tokenHash: legacy[providerId] });
  }
  return out;
}

/** A stored profile reduced to what matching needs. */
export interface HashedProfileRef { profileId: string; providerId: string; tokenHash: string }

/** The API shape: what one agent holds for one provider, matched to the vault. */
export interface DetectedCredential {
  providerId: string;
  /**
   * True/false from a successful read. null: the container could not be read for this provider
   * (the secret store failed, or the probe script did not finish): the page must not guess.
   */
  present: boolean | null;
  /** The vault profile whose token the agent holds; null when absent or matching no stored profile. */
  profileId: string | null;
  /** Every stored profile with that same token (normally one). */
  profileIds: string[];
  method: DetectMethod | null;
  login?: string;
}

/** One entry for every provider, `present: false` where the agent holds nothing, null where it could not be read. */
export function resolveCredentials(
  holdings: Holding[],
  profiles: HashedProfileRef[],
  readable: { digestOk: boolean; storeOk: boolean } = { digestOk: true, storeOk: true },
): DetectedCredential[] {
  return Object.keys(TOKEN_FIELD).map((providerId): DetectedCredential => {
    if (!readable.digestOk || (providerId in STORE_ENTRY && !readable.storeOk)) {
      return { providerId, present: null, profileId: null, profileIds: [], method: null };
    }
    const h = holdings.find((x) => x.providerId === providerId);
    if (!h) return { providerId, present: false, profileId: null, profileIds: [], method: null };
    const ids = h.tokenHash
      ? profiles.filter((p) => p.providerId === providerId && p.tokenHash === h.tokenHash).map((p) => p.profileId)
      : [];
    return { providerId, present: true, profileId: ids[0] ?? null, profileIds: ids, method: h.method, ...(h.login ? { login: h.login } : {}) };
  });
}
