import { pickSubscriptionModel } from '@/lib/agent-model-setup';
import type { SubscriptionProviderId } from '@/lib/subscription-providers';

const TERMS_CHECK_MS = 15_000;
const MODELS_RETRY_MS = 5_000;
const MODELS_WAIT_MS = 120_000;
const MODELS_TIMEOUT = "Timed out waiting for the account's models.";
const LOGIN_RETRY_MS = 2_000;
const LOGIN_WAIT_MS = 30_000;
const LOGIN_BUSY = 'A subscription login for this agent is running';
const SAVE_WAIT_MS = 60_000;
const SAVE_TIMEOUT = 'The model save did not answer in time. Check the Model section.';

export const TERMS_REQUIRED = "Anthropic asks this account to accept its updated terms at claude.ai first. Accept them, then choose Use Claude again.";

export type SubscriptionModelSetupPhase = 'waiting' | 'setting';
export type SubscriptionModelSetupOutcome =
  | { kind: 'set'; key: string; name: string }
  | { kind: 'already-set' }
  | { kind: 'terms-required' }
  | { kind: 'error'; message: string };

type Model = { key: string; name: string };
type SaveAnswer = { status?: string; code?: string; verify?: { ok: boolean }; error?: string };

/** Limit the whole operation, including the response body, without cancelling the caller's action. */
async function withTimeout<T>(
  signal: AbortSignal,
  delay: number,
  message: string,
  run: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const local = new AbortController();
  const abort = () => local.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => local.abort(new Error(message)), delay);
  try {
    const result = await run(local.signal);
    local.signal.throwIfAborted();
    return result;
  } catch (error) {
    local.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function waitForRetry(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A fresh usage read for the signed-in account. Failed or slow reads leave setup available. */
async function claudeTermsRequired(email: string, signal: AbortSignal): Promise<boolean> {
  try {
    return await withTimeout(signal, TERMS_CHECK_MS, 'The Claude terms check timed out.', async (requestSignal) => {
      const response = await fetch(
        `/api/subscriptions/usage?provider=anthropic&refresh=1&email=${encodeURIComponent(email)}`,
        { signal: requestSignal, cache: 'no-store' },
      );
      if (!response.ok) return false;
      const data = await response.json().catch(() => ({})) as { errors?: { email?: string; code?: string }[] };
      return (data.errors ?? []).some((error) => error.email === email && error.code === 'terms-required');
    });
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function loadModels(provider: SubscriptionProviderId, agentId: string, signal: AbortSignal): Promise<Model[]> {
  const url = `/api/subscriptions/models?provider=${provider}&agentId=${encodeURIComponent(agentId)}`;
  return withTimeout(signal, MODELS_WAIT_MS, MODELS_TIMEOUT, async (requestSignal) => {
    for (;;) {
      requestSignal.throwIfAborted();
      const response = await fetch(url, { signal: requestSignal, cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { models?: Model[]; pending?: boolean; error?: string | null };
      requestSignal.throwIfAborted();
      if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
      if (!data.pending) {
        if (data.error) throw new Error(data.error);
        return data.models ?? [];
      }
      await waitForRetry(requestSignal, MODELS_RETRY_MS);
    }
  });
}

async function saveModel(agentId: string, key: string, signal: AbortSignal): Promise<'set' | 'already-set'> {
  const body = JSON.stringify({ containerName: agentId, model: `subscription:${key}`, fallbacks: [], onlyIfUnset: true });
  const deadline = performance.now() + LOGIN_WAIT_MS;
  for (;;) {
    const { response, data } = await withTimeout(signal, SAVE_WAIT_MS, SAVE_TIMEOUT, async (requestSignal) => {
      const response = await fetch('/api/gateway/agent', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal: requestSignal,
      });
      const data = await response.json().catch(() => ({})) as SaveAnswer;
      return { response, data };
    });
    signal.throwIfAborted();
    if (response.status === 409 && data.code === 'model-already-set') return 'already-set';
    if (response.status === 409 && data.error === LOGIN_BUSY) {
      // The deadline prevents new attempts. A sent PUT keeps its own 60 s budget.
      if (performance.now() >= deadline) throw new Error(LOGIN_BUSY);
      await waitForRetry(signal, LOGIN_RETRY_MS);
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error(LOGIN_BUSY);
      continue;
    }
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    if (data.status !== 'ok' || data.verify?.ok === false) throw new Error(data.error || 'Could not set the model.');
    return 'set';
  }
}

/** Set up a subscription model for one agent. Cancellation rejects with the caller's abort reason. */
export async function setupSubscriptionModel({ agentId, provider, email, signal, onProgress }: {
  agentId: string;
  provider: SubscriptionProviderId;
  email: string | null;
  signal: AbortSignal;
  onProgress: (phase: SubscriptionModelSetupPhase) => void;
}): Promise<SubscriptionModelSetupOutcome> {
  try {
    signal.throwIfAborted();
    onProgress('waiting');
    if (provider === 'anthropic' && email && await claudeTermsRequired(email, signal)) {
      signal.throwIfAborted();
      return { kind: 'terms-required' };
    }
    const models = await loadModels(provider, agentId, signal);
    signal.throwIfAborted();
    const key = pickSubscriptionModel(provider, models);
    if (!key) return { kind: 'error', message: 'The account did not offer a subscription model.' };

    onProgress('setting');
    const saved = await saveModel(agentId, key, signal);
    signal.throwIfAborted();
    if (saved === 'already-set') return { kind: 'already-set' };
    return { kind: 'set', key, name: models.find((model) => model.key === key)?.name || key };
  } catch (error) {
    signal.throwIfAborted();
    return { kind: 'error', message: error instanceof Error ? error.message : 'Could not set the model.' };
  }
}
