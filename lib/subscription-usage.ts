/**
 * The ChatGPT (Codex) usage limits: the 5-hour and weekly windows, with their reset times.
 *
 * The quota belongs to the ACCOUNT, not to an agent: every agent signed in with it, and the
 * owner's own Codex use, draw from the same windows. So the usage is read once per account,
 * from ONE running connected agent (found with the fast status read), through
 * `openclaw status --usage --json`. That is an OpenClaw CLI call (11 to 50 s on a slow host,
 * about 360 MB), so the result AND a failure are cached per account for 3 minutes (the next
 * refresh does not start another CLI); concurrent requests for the same account share one
 * call; only `refresh=1` forces a read. The call runs under an in-container `timeout`, because
 * a host-side deadline leaves the process running there. A failure for one account is
 * reported in `errors` and never fails the others.
 */
import { dockerExec } from '@/lib/docker-exec';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import { parseUsageStatus, usageCacheAction, type UsageAccount } from '@/lib/subscriptions-parse';
import { findAccountSources, subscriptionGeneration } from '@/lib/subscriptions';

const TTL_MS = 3 * 60_000;
const IN_CONTAINER_TIMEOUT_S = 120;
const HOST_TIMEOUT_MS = 130_000;

export interface UsageError {
  email: string | null;
  message: string;
}

export interface SubscriptionUsage {
  accounts: UsageAccount[];
  errors: UsageError[];
}

interface Entry {
  at: number;
  /** null: the read failed (cached too, for the same 3 minutes). */
  account: UsageAccount | null;
}

const g = globalThis as unknown as {
  __rev4aUsageCache?: Map<string, Entry>;
  __rev4aUsageInflight?: Map<string, Promise<UsageAccount>>;
};
const cache = (): Map<string, Entry> => (g.__rev4aUsageCache ??= new Map());
const inflight = (): Map<string, Promise<UsageAccount>> => (g.__rev4aUsageInflight ??= new Map());

async function readUsage(container: string, email: string): Promise<UsageAccount> {
  const out = await dockerExec(
    container,
    ['timeout', String(IN_CONTAINER_TIMEOUT_S), ...gatewayCliArgv(['status', '--usage', '--json'])],
    { timeoutMs: HOST_TIMEOUT_MS },
  );
  // A docker exec that hit its deadline resolves with no output: that is a failure, not "no usage".
  if (!out.trim()) throw new Error('no output');
  const { accounts } = parseUsageStatus(out);
  // The CLI reports the account its agent is signed in with: prefer the one asked for.
  const account = accounts.find((a) => a.email === email) ?? (accounts.length === 1 ? accounts[0] : null);
  if (!account || account.windows.length === 0) throw new Error('no usage');
  return { ...account, email };
}

function usageFor(email: string, container: string, refresh: boolean): Promise<UsageAccount> {
  const hit = cache().get(email);
  if (hit && usageCacheAction(hit, Date.now(), refresh, TTL_MS) === 'use') {
    return hit.account ? Promise.resolve(hit.account) : Promise.reject(new Error('usage read failed recently'));
  }
  const pending = inflight().get(email);
  if (pending) return pending;
  const gen = subscriptionGeneration();
  const p = readUsage(container, email)
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

/** One running connected agent per account email (cached discovery, fast status read). */
async function findSources(only: string | null): Promise<Map<string, { container: string; name: string }>> {
  const all = await findAccountSources();
  const sources = new Map<string, { container: string; name: string }>();
  for (const [email, src] of all) {
    if (!email || (only && email !== only)) continue;
    sources.set(email, src);
  }
  return sources;
}

export async function getSubscriptionUsage(opts: { email?: string | null; refresh?: boolean } = {}): Promise<SubscriptionUsage> {
  const sources = await findSources(opts.email ?? null);
  const accounts: UsageAccount[] = [];
  const errors: UsageError[] = [];
  await Promise.all([...sources].map(async ([email, src]) => {
    try {
      accounts.push(await usageFor(email, src.container, !!opts.refresh));
    } catch {
      errors.push({ email, message: `Could not read the usage from ${src.name}` });
    }
  }));
  accounts.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
  return { accounts, errors };
}
