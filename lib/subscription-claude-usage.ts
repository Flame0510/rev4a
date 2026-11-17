/**
 * The Claude plan's usage limits (the 5-hour and the weekly window), in the shape of the ChatGPT
 * usage (`lib/subscription-usage.ts`).
 *
 * OpenClaw does not report Anthropic usage for a Claude Code login and Claude Code keeps no
 * utilization on disk: it reports it only while answering. So each read is ONE tiny Claude Code
 * call inside a running connected agent (`CLAUDE_USAGE_PROBE`: about 1.5 s and a few hundred tokens of the plan (Haiku, no tools, no session), measured live 2026-11-14). Only its usage windows or terms-required result are retained. The quota belongs to the
 * ACCOUNT, so one probe per account; the result AND a failure are cached per account for 3
 * minutes; `refresh` bypasses the cache; concurrent callers for one account share one probe. No
 * credential file is ever read. A failure for one account is an `errors` entry, never a failed
 * response for the others.
 */
import { usageCacheAction, type UsageAccount } from '@/lib/subscriptions-parse';
import { subscriptionGeneration } from '@/lib/subscriptions';
import { claudePlanFor, findClaudeSources } from '@/lib/subscription-claude';
import { CLAUDE_TERMS_MESSAGE } from '@/lib/subscription-claude-parse';
import { runClaudeProbe } from '@/lib/claude-probe';
import type { SubscriptionUsage, UsageError } from '@/lib/subscription-usage';

const TTL_MS = 3 * 60_000;
export const CLAUDE_USAGE_ERROR = 'Could not read the Claude usage limits.';

type Result = { account: UsageAccount } | { error: UsageError };
interface Entry {
  at: number;
  result: Result;
}

const g = globalThis as unknown as {
  __rev4aClaudeUsageCache?: Map<string, Entry>;
  __rev4aClaudeUsageInflight?: Map<string, Promise<Result>>;
};
const cache = (): Map<string, Entry> => (g.__rev4aClaudeUsageCache ??= new Map());
const inflight = (): Map<string, Promise<Result>> => (g.__rev4aClaudeUsageInflight ??= new Map());

async function probe(container: string, email: string): Promise<Result> {
  const result = await runClaudeProbe(container);
  if ('termsRequired' in result) return { error: { email, code: 'terms-required', message: CLAUDE_TERMS_MESSAGE } };
  if ('failed' in result) return { error: { email, message: CLAUDE_USAGE_ERROR } };
  return { account: { email, plan: claudePlanFor(email), windows: result.windows, updatedAt: new Date().toISOString() } };
}

function usageFor(email: string, container: string, refresh: boolean): Promise<Result> {
  const hit = cache().get(email);
  if (hit?.result && usageCacheAction(hit, Date.now(), refresh, TTL_MS) === 'use') {
    return Promise.resolve(hit.result);
  }
  const pending = inflight().get(email);
  if (pending) return pending;
  const gen = subscriptionGeneration();
  const p = probe(container, email)
    .then((result) => {
      if (subscriptionGeneration() === gen) cache().set(email, { at: Date.now(), result });
      return result;
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
      const result = await usageFor(email, container, !!opts.refresh);
      if ('account' in result) accounts.push(result.account);
      else errors.push(result.error);
    } catch {
      errors.push({ email, message: CLAUDE_USAGE_ERROR });
    }
  }));
  accounts.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
  return { accounts, errors };
}
