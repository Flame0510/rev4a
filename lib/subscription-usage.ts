/**
 * The ChatGPT (Codex) usage limits: the 5-hour and weekly windows, with their reset times.
 *
 * The quota belongs to the ACCOUNT, not to an agent: every agent signed in with it, and the
 * owner's own Codex use, draw from the same windows. So the usage is read once per account,
 * from ONE running connected agent (found with the fast status read), through
 * `openclaw status --usage --json`. That is an OpenClaw CLI call (about 7 s), so the result is
 * cached per account for 3 minutes; concurrent requests for the same account share one call.
 * A failure for one account is reported in `errors` and never fails the others.
 */
import { dockerExec, mapWithConcurrency } from '@/lib/docker-exec';
import { parseUsageStatus, type UsageAccount } from '@/lib/subscriptions-parse';
import { listAgentContainers, readAgentState, subscriptionGeneration } from '@/lib/subscriptions';

const TTL_MS = 3 * 60_000;
const CLI_TIMEOUT_MS = 30_000;

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
  account: UsageAccount;
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
    ['sh', '-c', 'OPENCLAW_GATEWAY_URL=ws://127.0.0.1:3000 openclaw status --usage --json'],
    { timeoutMs: CLI_TIMEOUT_MS },
  );
  const { accounts } = parseUsageStatus(out);
  // The CLI reports the account its agent is signed in with: prefer the one asked for.
  const account = accounts.find((a) => a.email === email) ?? (accounts.length === 1 ? accounts[0] : null);
  if (!account || account.windows.length === 0) throw new Error('no usage');
  return { ...account, email };
}

function usageFor(email: string, container: string, refresh: boolean): Promise<UsageAccount> {
  const hit = cache().get(email);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.account);
  const pending = inflight().get(email);
  if (pending) return pending;
  const gen = subscriptionGeneration();
  const p = readUsage(container, email)
    .then((account) => {
      if (subscriptionGeneration() === gen) cache().set(email, { at: Date.now(), account });
      return account;
    })
    .finally(() => { inflight().delete(email); });
  inflight().set(email, p);
  return p;
}

/** One running connected agent per account email, from the fast status read. */
async function findSources(only: string | null): Promise<Map<string, { container: string; name: string }>> {
  const running = (await listAgentContainers()).filter((a) => a.running);
  const found = await mapWithConcurrency(running, 4, async (a) => {
    try {
      const s = await readAgentState(a.container);
      return s.profiles.filter((p) => p.email).map((p) => ({ email: p.email as string, container: a.container, name: a.displayName || a.agentId }));
    } catch {
      return [];
    }
  });
  const sources = new Map<string, { container: string; name: string }>();
  for (const list of found) {
    for (const s of list) {
      if (only && s.email !== only) continue;
      if (!sources.has(s.email)) sources.set(s.email, { container: s.container, name: s.name });
    }
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
