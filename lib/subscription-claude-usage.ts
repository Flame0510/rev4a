/**
 * The Claude plan's usage limits (the 5-hour and the weekly window), in the shape of the ChatGPT
 * usage (`lib/subscription-usage.ts`).
 *
 * OpenClaw does not report Anthropic usage for a Claude Code login and Claude Code keeps no
 * utilization on disk: it reports it only while answering. So each read is ONE tiny Claude Code
 * call inside a running connected agent (`CLAUDE_USAGE_PROBE`: about 1.5 s and a few hundred tokens of the plan (Haiku, no tools, no session), measured live 2026-11-14), and only its `rate_limit_event` line is read. The quota belongs to the
 * ACCOUNT, so one probe per account; the result AND a failure are cached per account for 3
 * minutes; `refresh` bypasses the cache; concurrent callers for one account share one probe. No
 * credential file is ever read. A failure for one account is an `errors` entry, never a failed
 * response for the others.
 */
import { dockerExec } from '@/lib/docker-exec';
import { usageCacheAction, type UsageAccount } from '@/lib/subscriptions-parse';
import { subscriptionGeneration } from '@/lib/subscriptions';
import { claudePlanFor, findClaudeSources } from '@/lib/subscription-claude';
import { CLAUDE_USAGE_PROBE, parseClaudeUsageEvent } from '@/lib/subscription-claude-parse';
import type { SubscriptionUsage, UsageError } from '@/lib/subscription-usage';

const TTL_MS = 3 * 60_000;
/** The probe's own in-container `timeout` is 60 s; the host deadline leaves room for the exec itself. */
const HOST_TIMEOUT_MS = 70_000;
export const CLAUDE_USAGE_ERROR = 'Could not read the Claude usage limits.';

interface Entry {
  at: number;
  /** null: the probe failed (cached too, for the same 3 minutes). */
  account: UsageAccount | null;
}

const g = globalThis as unknown as {
  __rev4aClaudeUsageCache?: Map<string, Entry>;
  __rev4aClaudeUsageInflight?: Map<string, Promise<UsageAccount>>;
};
const cache = (): Map<string, Entry> => (g.__rev4aClaudeUsageCache ??= new Map());
const inflight = (): Map<string, Promise<UsageAccount>> => (g.__rev4aClaudeUsageInflight ??= new Map());

async function probe(container: string, email: string): Promise<UsageAccount> {
  const out = await dockerExec(container, ['sh', '-c', CLAUDE_USAGE_PROBE], { timeoutMs: HOST_TIMEOUT_MS });
  // A docker exec that hit its deadline resolves with no output: that is a failure, not "no usage".
  const windows = parseClaudeUsageEvent(out);
  if (!windows) throw new Error('no usage');
  return { email, plan: claudePlanFor(email), windows, updatedAt: new Date().toISOString() };
}

function usageFor(email: string, container: string, refresh: boolean): Promise<UsageAccount> {
  const hit = cache().get(email);
  if (hit && usageCacheAction(hit, Date.now(), refresh, TTL_MS) === 'use') {
    return hit.account ? Promise.resolve(hit.account) : Promise.reject(new Error('usage read failed recently'));
  }
  const pending = inflight().get(email);
  if (pending) return pending;
  const gen = subscriptionGeneration();
  const p = probe(container, email)
    .then((account) => {
      if (subscriptionGeneration() === gen) cache().set(email, { at: Date.now(), account });
      return account;
    })
    .catch((e: unknown) => {
      if (subscriptionGeneration() === gen) cache().set(email, { at: Date.now(), account: null });
      throw e;
    })
    .finally(() => { inflight().delete(email); });
  inflight().set(email, p);
  return p;
}

export async function getClaudeUsage(opts: { email?: string | null; refresh?: boolean } = {}): Promise<SubscriptionUsage> {
  const all = await findClaudeSources();
  const accounts: UsageAccount[] = [];
  const errors: UsageError[] = [];
  const only = opts.email ?? null;
  await Promise.all([...all].map(async ([email, container]) => {
    if (!email || (only && email !== only)) return;
    try {
      accounts.push(await usageFor(email, container, !!opts.refresh));
    } catch {
      errors.push({ email, message: CLAUDE_USAGE_ERROR });
    }
  }));
  accounts.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
  return { accounts, errors };
}
