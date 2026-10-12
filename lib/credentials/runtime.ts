import { dockerExecNoFail } from '@/lib/docker-exec';
import { isSubscriptionProvider } from '@/lib/agent-costs';

type ModelRef = string | { primary?: unknown } | null | undefined;

const primaryOf = (m: ModelRef): string | null => {
  const p = typeof m === 'string' ? m : m && typeof m === 'object' ? m.primary : null;
  return typeof p === 'string' && p ? p : null;
};

/**
 * Whether an agent's model runs on the ChatGPT (Codex) runtime, where the secret store's
 * environment entries reach only commands run through OpenClaw. The `main` entry of
 * `agents.list` (what the model panel writes) wins over `agents.defaults.model`. The
 * provider rule is the one the Costs page uses (`isSubscriptionProvider`).
 * Best-effort: false when the config cannot be read. One cheap `cat`, no OpenClaw CLI.
 */
export async function agentUsesCodex(container: string): Promise<boolean> {
  const raw = await dockerExecNoFail(container, ['cat', '/root/.openclaw/openclaw.json'], {
    timeoutMs: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!raw) return false;
  try {
    const agents = (JSON.parse(raw) as { agents?: { defaults?: { model?: ModelRef }; list?: { id?: string; model?: ModelRef }[] } })?.agents;
    const main = Array.isArray(agents?.list) ? agents.list.find((e) => e && e.id === 'main') : undefined;
    const primary = primaryOf(main?.model) ?? primaryOf(agents?.defaults?.model);
    return isSubscriptionProvider(primary?.split('/')[0]);
  } catch {
    return false;
  }
}
