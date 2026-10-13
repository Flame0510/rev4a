import { dockerExec, dockerExecShell, dockerExecWithInput, mapWithConcurrency } from '@/lib/docker-exec';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { agentBusyReason } from '@/lib/agent-busy';
import { listAgentContainers as listAgentRows } from '@/lib/subscriptions';
import { waitForGatewayReady } from '@/lib/agent-readiness';
import { writeRefusal } from './guard';
import { getSecret, getProfile, markSynced, markDesynced } from './vault';
import { getProvider } from './providers';
import { listAgentContainers as listAgentContainerInfo } from './detect';
import {
  getAssignment,
  listLiveForAgent,
  recordAssignment,
  removalRecordState,
  setAssignmentError,
  supersedeSiblings,
} from './assignments';
import {
  assertDeliverable,
  needsNativeRemoval,
  nativeProvider,
  redact,
  runDisable,
  runEnable,
  UnsupportedNativeVersionError,
  type AssignmentMode,
  type NativeExec,
} from './native';
import {
  discoverVercelTeam,
  githubDisable,
  githubEnable,
  removeStoreEntries,
  vercelDisable,
  vercelEnable,
} from './managed';

/** Containers written to at once. Writes are heavier than reads, so lower. */
const AGENT_WRITE_CONCURRENCY = 4;

export interface SyncResult {
  container: string;
  status: 'ok' | 'error';
  error?: string;
  /** The switch worked, but a leftover of an earlier release could not be removed. */
  warning?: string;
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

/** Printed after the file, so its absence proves the read was cut short. */
const READ_COMPLETE = '\x04';

/**
 * Read a file from a container.
 *
 * Returns '' when the file is genuinely absent or empty, and null when the read
 * did not complete. Callers that write the file back MUST treat null as "do not
 * write": to the rewrite path an unfinished read is indistinguishable from an
 * empty file, and the branch that finds no block to edit would rewrite the whole file.
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
 * terminator is still printed, and the caller correctly gets '' — an agent from the
 * `custom` template starts without a TOOLS.md until OpenClaw writes one.
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


// ── TOOLS.md integration block: removal only ─────────────────────────────
// Rev4a no longer writes this block; earlier releases did, and a successful switch-on
// removes the row they left for the provider (cleanLegacy below).

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
 * Remove a single provider's row from the TOOLS.md integration block inside an agent
 * container (docker exec only). Throws when TOOLS.md cannot be read, so a removal that did
 * not happen is never reported as done.
 */
async function removeProviderRow(container: string, providerId: string): Promise<void> {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return;

  const entry = PROVIDER_ENTRIES[providerId];
  if (!entry) return;

  const existing = await containerRead(safe, TOOLS_MD_PATH);
  // A failed read must not lead to a write (an unreadable file is not an empty one).
  if (existing === null) throw new Error('TOOLS.md could not be read');
  const si = existing.indexOf(MARKER_START);
  const ei = existing.indexOf(MARKER_END);
  if (si === -1 || ei === -1 || ei <= si) return; // No block to edit

  const rows = extractRows(existing, si, ei).filter((r) => !r.includes(`\`${entry.tool}\``));
  const entries = rowsToEntries(rows);
  const newBlock = entries.length ? buildBlock(entries) : '';
  const patched = existing.slice(0, si) + newBlock + existing.slice(ei + MARKER_END.length);
  await containerExec(safe, writeAtomically(patched, TOOLS_MD_PATH));
}

// ── Old-way artefacts (written by earlier releases) ──────────────────────

/**
 * Remove the files an earlier release wrote for one provider in one container, and its
 * TOOLS.md row. Never throws: returns what failed, as short messages, so the caller can say
 * the removal was only partial instead of reporting success.
 */
async function cleanLegacy(container: string, providerId: string): Promise<string[]> {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) return [];
  const warnings: string[] = [];

  const script: Record<string, string> = {
    'github-pat': 'rm -rf /root/.config/gh /root/.local/share/gh 2>/dev/null; exit 0',
    // No `vercel` entry: the CLI's own files ARE the native delivery now
    // (managed.ts). The removal happens in vercelDisable, only on switch-off —
    // removing them here would delete the files an enable just wrote.
    supabase: 'rm -f /root/.supabase/access-token 2>/dev/null; exit 0',
    trello: 'rm -rf /root/.config/trello',
    notion: 'rm -rf /root/.config/notion',
  };
  if (script[providerId]) {
    try { await containerExec(safe, script[providerId], 10000); }
    catch { warnings.push('the old CLI files could not be removed'); }
  }
  try { await removeProviderRow(safe, providerId); }
  catch { warnings.push('the TOOLS.md row could not be removed'); }
  return warnings;
}

// ── Native delivery: OpenClaw secret store + skill config ──────────────────

const NATIVE_TIMEOUT_MS = 30_000;

function execFor(container: string): NativeExec {
  return {
    run: (argv, env) => dockerExec(container, argv, { timeoutMs: NATIVE_TIMEOUT_MS, ...(env ? { env } : {}) }),
    runWithInput: (argv, input) => dockerExecWithInput(container, argv, input, { timeoutMs: NATIVE_TIMEOUT_MS }),
  };
}

// ── Provider dispatch ───────────────────────────────────────────────────────

/**
 * Secret-store `env` entries an earlier native delivery wrote for a provider the
 * secret store can no longer carry (or never could). GitHub's names are dropped by
 * OpenClaw; Vercel's are ignored by the CLI. They are cleaned on enable and disable.
 */
const STALE_ENV_ENTRIES: Record<string, readonly string[]> = {
  'github-pat': ['GH_TOKEN', 'GITHUB_TOKEN'],
  vercel: ['VERCEL_TOKEN'],
};

/** Deliver one provider, including the two the secret store cannot carry (see managed.ts). */
async function applyEnable(exec: NativeExec, providerId: string, secret: Record<string, string>): Promise<void> {
  if (providerId === 'github-pat') {
    const token = (secret.token ?? '').trim();
    if (!token) throw new Error('Missing token in the stored credential');
    await runEnable(exec, providerId, secret); // switch the bundled github skill on
    await removeStoreEntries(exec, STALE_ENV_ENTRIES['github-pat']);
    await githubEnable(exec, token);
    return;
  }
  if (providerId === 'vercel') {
    const token = (secret.token ?? '').trim();
    if (!token) throw new Error('Missing token in the stored credential');
    await assertDeliverable(exec, providerId); // same version floor as every other provider
    const team = await discoverVercelTeam(token);
    await vercelEnable(exec, token, team);
    await removeStoreEntries(exec, STALE_ENV_ENTRIES.vercel);
    return;
  }
  await runEnable(exec, providerId, secret);
}

/** Remove one provider. Every step is attempted; returns the failures (empty = fully removed). */
async function applyDisable(exec: NativeExec, providerId: string, values: readonly string[]): Promise<string[]> {
  if (providerId !== 'github-pat' && providerId !== 'vercel') return runDisable(exec, providerId, values);
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) { errors.push(redact(`${what}: ${(e as Error).message}`, values)); }
  };
  if (providerId === 'github-pat') {
    await attempt('remove the GitHub identity', () => githubDisable(exec));
    await attempt('remove the github skill entry', () => runDisable(exec, providerId, values));
  } else {
    await attempt('remove the Vercel config', () => vercelDisable(exec));
  }
  await attempt('remove the leftover environment entries', () => removeStoreEntries(exec, STALE_ENV_ENTRIES[providerId]));
  return errors;
}

/**
 * One change at a time per container, on the queue every writer of the agent's openclaw.json
 * shares (lib/agent-config-lock.ts): `openclaw config patch` is a read-modify-write of the
 * file, so two providers delivered to one agent at once — or a delivery racing a runtime
 * patch or a whole-file rewrite — would lose an update.
 */
const serialized = withAgentConfigLock;

const safeName = (c: string): string => c.replace(/[^a-zA-Z0-9_.-]/g, '');

/**
 * Why a user-facing switch on or off must not run on this agent now (stopped, gone, or owned
 * by an update / recreate / restore / edit / backup), or null. `reapplyAssignments` does not
 * call this: the jobs run it themselves once they have finished. When Docker cannot be read
 * the answer is null, so the attempt fails (and is recorded) the way it always did.
 */
export async function agentWriteRefusal(container: string): Promise<string | null> {
  const name = safeName(container);
  try {
    const row = (await listAgentRows({ fresh: true })).find((a) => a.container === name);
    return writeRefusal({
      exists: !!row,
      running: !!row?.running,
      busy: row ? await agentBusyReason(row.agentId) : null,
    });
  } catch {
    return null;
  }
}

function secretValues(profileId: string): string[] {
  try { return Object.values(getSecret(profileId)); } catch { return []; }
}

/**
 * Switch a credential on for one agent: the provider's delivery (the secret store and skill
 * config, the GitHub identity, or the Vercel CLI files). Only once that worked are the files
 * and the TOOLS.md row an earlier release wrote for this provider removed, so an agent whose
 * delivery fails keeps what it had. Never throws.
 */
export async function enableAssignment(
  profileId: string,
  container: string,
  mode: AssignmentMode = 'env',
  opts: { onlyIfEnabled?: boolean } = {},
): Promise<SyncResult> {
  const name = safeName(container);
  if (!name) return { container, status: 'error', error: 'Invalid agent name' };
  const profile = getProfile(profileId);
  if (!profile) return { container: name, status: 'error', error: 'Credential not found' };
  if (mode !== 'env') {
    return { container: name, status: 'error', error: 'Protected mode is not available yet' };
  }
  if (!nativeProvider(profile.providerId)) {
    return { container: name, status: 'error', error: `No native delivery for ${profile.providerId}` };
  }
  const refusal = await agentWriteRefusal(name);
  if (refusal) return { container: name, status: 'error', error: refusal };

  return serialized(name, async (): Promise<SyncResult> => {
    // A re-delivery (secret edited) must not switch back on what was switched off meanwhile.
    if (opts.onlyIfEnabled && !getAssignment(profileId, name)?.enabled) return { container: name, status: 'ok' };
    try {
      await applyEnable(execFor(name), profile.providerId, getSecret(profileId));
    } catch (e) {
      const error = (e as Error).message;
      // An unsupported version refused delivery before writing anything. Preserve any
      // previous assignment, and do not invent an enabled row for a new one.
      if (!(e instanceof UnsupportedNativeVersionError)) {
        try { recordAssignment(profileId, name, { enabled: true, mode, ok: false, error }); } catch { /* keep the delivery result */ }
      }
      try { markSynced(profileId, 'error'); } catch { /* keep the delivery result */ }
      return { container: name, status: 'error', error };
    }
    // Migration: only this provider, only this agent. Idempotent.
    const warnings = await cleanLegacy(name, profile.providerId);
    try {
      supersedeSiblings(profileId, profile.providerId, name);
      recordAssignment(profileId, name, { enabled: true, mode, ok: true });
      markSynced(profileId, 'active');
    } catch (e) {
      console.warn(`[credentials] delivered to ${name} but could not record it:`, (e as Error).message);
    }
    return warnings.length
      ? { container: name, status: 'ok', warning: `Switched on, but ${warnings.join(' and ')}` }
      : { container: name, status: 'ok' };
  });
}

/**
 * Switch a credential off for one agent. The native removal runs only when this row is
 * enabled or still pending a removal: a sibling that another profile replaced shares the
 * same environment names, and removing them would wipe the active credential. Every step is
 * tried; if any fails the row stays in "removal pending" (kept, retried at re-apply, blocks
 * deleting the credential). Anything an earlier release wrote is removed too. Never throws.
 */
export async function disableAssignment(
  profileId: string,
  container: string,
  // `held`: the Credentials page saw this profile's token in the container (the container is the
  // source of truth), so the removal runs even when Rev4a has no enabled row for it.
  // `intentOnly`: clear only Rev4a's own setting (enabled = false), touch nothing in the container.
  // It is for a row whose agent holds ANOTHER credential of the same provider: a provider-wide
  // removal would delete that other credential.
  opts: { held?: boolean; intentOnly?: boolean } = {},
): Promise<SyncResult> {
  const name = safeName(container);
  if (!name) return { container, status: 'error', error: 'Invalid agent name' };
  const profile = getProfile(profileId);
  if (!profile) return { container: name, status: 'error', error: 'Credential not found' };
  if (opts.intentOnly) {
    return serialized(name, async (): Promise<SyncResult> => {
      const cur = getAssignment(profileId, name);
      // A removal that is still pending has real work to do in the container: not an intent-only case.
      if (cur?.pendingRemoval) return { container: name, status: 'error', error: 'A removal is pending on this agent: retry it instead' };
      if (cur) {
        try { recordAssignment(profileId, name, { enabled: false, ok: true }); }
        catch (e) { return { container: name, status: 'error', error: (e as Error).message }; }
      }
      return { container: name, status: 'ok' };
    });
  }
  const refusal = await agentWriteRefusal(name);
  if (refusal) return { container: name, status: 'error', error: refusal };

  return serialized(name, async (): Promise<SyncResult> => {
    const existing = getAssignment(profileId, name);
    // Replaced by another profile of the same provider: nothing of its own is on the agent.
    if (existing && !needsNativeRemoval(existing) && !opts.held) return { container: name, status: 'ok' };
    // Switched on but never delivered (its enable failed) while a sibling of the same provider
    // is delivered here: the environment names on the agent are the sibling's, leave them.
    if (!opts.held && existing && existing.enabled && !existing.pendingRemoval && existing.syncedAt == null
      && listLiveForAgent(name).some((o) => o.profileId !== profileId && o.enabled && o.syncedAt != null
        && getProfile(o.profileId)?.providerId === profile.providerId)) {
      try { recordAssignment(profileId, name, { enabled: false, ok: true }); } catch { /* keep the result */ }
      return { container: name, status: 'ok' };
    }

    let errors: string[] = [];
    if (existing || opts.held) {
      try {
        errors = await applyDisable(execFor(name), profile.providerId, secretValues(profileId));
      } catch (e) {
        errors = [redact((e as Error).message, secretValues(profileId))];
      }
    }
    const warnings = await cleanLegacy(name, profile.providerId);

    const removalState = removalRecordState(existing, opts.held === true, errors);
    if (removalState) {
      try {
        recordAssignment(profileId, name, removalState);
      } catch { /* keep the result */ }
    }
    if (errors.length) return { container: name, status: 'error', error: `Removal failed: ${errors.join('; ')}` };
    try { markDesynced(profileId); } catch { /* keep the result */ }
    return warnings.length
      ? { container: name, status: 'ok', warning: `Switched off, but ${warnings.join(' and ')}` }
      : { container: name, status: 'ok' };
  });
}

/**
 * Bring one agent in line with its assignments: enabled ones are delivered again, pending
 * removals are retried. Called in the background after create, recreate, update and edit
 * (the store and `openclaw.json` normally survive on the agent volume, so this is a
 * consistency pass). A failure is logged and kept in `last_error`; it never throws.
 */
export async function reapplyAssignments(container: string): Promise<void> {
  const name = safeName(container);
  if (!name) return;
  let assignments;
  try {
    assignments = listLiveForAgent(name);
  } catch (e) {
    console.warn(`[credentials] assignments unreadable for ${name}:`, (e as Error).message);
    return;
  }
  for (const listed of assignments) {
    // Decided inside the per-agent queue from a fresh read: a switch-off (or a re-enable)
    // made while this pass waited must win over the snapshot taken above.
    await serialized(name, async () => {
      const a = getAssignment(listed.profileId, name);
      if (!a || !needsNativeRemoval(a)) return;
      try {
        const profile = getProfile(a.profileId);
        if (!profile || !nativeProvider(profile.providerId)) return;
        if (a.enabled) {
          if (a.mode !== 'env') return;
          await applyEnable(execFor(name), profile.providerId, getSecret(a.profileId));
          recordAssignment(a.profileId, name, { enabled: true, mode: a.mode, ok: true });
          return;
        }
        // Pending removal. If another profile of the same provider is now active here, the
        // entries belong to it: only the pending mark goes.
        const takenOver = listLiveForAgent(name).some((o) => o.enabled && o.profileId !== a.profileId
          && getProfile(o.profileId)?.providerId === profile.providerId);
        const errors = takenOver ? [] : await applyDisable(execFor(name), profile.providerId, secretValues(a.profileId));
        recordAssignment(a.profileId, name, errors.length
          ? { enabled: false, pendingRemoval: true, ok: false, error: `Removal failed: ${errors.join('; ')}` }
          : { enabled: false, ok: true });
        if (errors.length) console.warn(`[credentials] removal still pending on ${name} (${a.profileId})`);
      } catch (e) {
        const error = redact((e as Error).message, secretValues(a.profileId));
        console.warn(`[credentials] re-apply failed on ${name} (${a.profileId}):`, error);
        try {
          recordAssignment(a.profileId, name, { enabled: a.enabled, mode: a.mode, ok: false, error, pendingRemoval: a.pendingRemoval });
        } catch { /* logged above */ }
      }
    }).catch((e) => console.warn(`[credentials] re-apply failed on ${name}:`, (e as Error).message));
  }
}

/** True only when the container is known to be running (an unreadable answer counts as not running). */
async function agentIsRunning(name: string): Promise<boolean> {
  try {
    return !!(await listAgentRows({ fresh: true })).find((a) => a.container === name)?.running;
  } catch {
    return false;
  }
}

/** How long a start, restart or update waits for the Gateway before giving up on the re-apply. */
const REAPPLY_READY_TIMEOUT_MS = 10 * 60_000;

export const GATEWAY_NOT_READY_ERROR = 'Gateway not ready — credentials not re-applied';

/**
 * Re-apply an agent's credentials once its Gateway answers /startupz, waiting up to ten
 * minutes (a slow host, an emulated image). If it never gets ready the enabled assignments
 * carry `last_error` "Gateway not ready — credentials not re-applied", so the Credentials page
 * says so instead of the re-apply failing silently. Never throws.
 */
export async function reapplyWhenReady(container: string, timeoutMs = REAPPLY_READY_TIMEOUT_MS): Promise<void> {
  const name = safeName(container);
  if (!name) return;
  try {
    if (await waitForGatewayReady(name, timeoutMs)) {
      await reapplyAssignments(name);
      return;
    }
    // Nothing to say about an agent that was stopped while we waited: its start re-applies.
    if (!(await agentIsRunning(name))) return;
    for (const a of listLiveForAgent(name)) {
      if (!a.enabled) continue;
      // Only the message: a row already delivered stays delivered (synced_at is kept).
      try { setAssignmentError(a.profileId, name, GATEWAY_NOT_READY_ERROR); } catch { /* logged below */ }
    }
    console.warn(`[credentials] ${name}: ${GATEWAY_NOT_READY_ERROR}`);
  } catch (e) {
    console.warn(`[credentials] re-apply after start failed on ${name}:`, (e as Error).message);
  }
}

/**
 * Enable a credential on the given containers (every agent when none are given).
 * This is what the legacy sync route now means. The profile's status and audit entry are
 * written per container by {@link enableAssignment}.
 */
export async function syncProfileToAgents(
  profileId: string,
  providerId: string,
  containers?: string[],
): Promise<SyncResult[]> {
  if (!getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
  const targets = [...new Set(containers ?? await listAgentContainers())].map(safeName).filter(Boolean);
  return mapWithConcurrency(targets, AGENT_WRITE_CONCURRENCY, (c) => enableAssignment(profileId, c));
}
