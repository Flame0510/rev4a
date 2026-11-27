'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, Pill, showToast } from '../components/ui';
import ClaudeConnectModal from '../subscriptions/ClaudeConnectModal';
import ConnectModal from '../subscriptions/ConnectModal';
import { EXPERIMENTAL_LABEL, getProviderCopy } from '../subscriptions/providers';
import { setupSubscriptionModel, TERMS_REQUIRED, type SubscriptionModelSetupPhase } from '../subscriptions/subscription-model-setup';
import { getSubscriptionProvider, type SubscriptionProviderId } from '@/lib/subscription-providers';
import { isClaudeConnected, type ClaudeStatus, type SubscriptionStatus } from './SubscriptionLine';

const providers = (['openai', 'anthropic'] as const).map((id) => {
  const provider = getSubscriptionProvider(id);
  const copy = getProviderCopy(id);
  if (!provider || !copy) throw new Error(`Missing subscription provider: ${id}`);
  return { provider, copy };
});

// Both status routes return the version refusal in agent.error. The supported version list
// in that message changes over time, and the server module cannot be imported by the client.
const UNSUPPORTED_PREFIX = 'This agent is not on a supported OpenClaw version (';

type Status = {
  unsupported: boolean;
  running: boolean;
  connected: Record<SubscriptionProviderId, boolean>;
  /** The signed-in account per provider, for the Claude terms check; null when unknown. */
  email: Record<SubscriptionProviderId, string | null>;
};
type Action = { provider: SubscriptionProviderId; phase: SubscriptionModelSetupPhase };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

async function readStatus(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const data = await readJson<{ agent: SubscriptionStatus & ClaudeStatus & { running: boolean } }>(response);
  if (!data.agent) throw new Error('Could not read this agent\'s subscription status.');
  return data.agent;
}

export default function ModelSetupModal({ agentId, agentName, onClose, onDone, onChoose }: {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onDone: () => void;
  onChoose: () => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [login, setLogin] = useState<SubscriptionProviderId | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const statusRef = useRef<AbortController | null>(null);
  const actionRef = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(async () => {
    statusRef.current?.abort();
    const controller = new AbortController();
    statusRef.current = controller;
    const url = `/api/subscriptions?agentId=${encodeURIComponent(agentId)}`;
    const [chatgpt, claude] = await Promise.allSettled([
      readStatus(url, controller.signal),
      readStatus(`${url}&provider=anthropic`, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    const openai = chatgpt.status === 'fulfilled' ? chatgpt.value : null;
    const anthropic = claude.status === 'fulfilled' ? claude.value : null;
    const errors = [chatgpt, claude].map((result) => result.status === 'fulfilled'
      ? result.value.error : (result.reason as Error).message);
    setStatus({
      unsupported: errors.some((message) => message?.startsWith(UNSUPPORTED_PREFIX)),
      running: (openai ?? anthropic)?.running ?? true,
      connected: {
        openai: !!openai?.connected && !openai.error,
        anthropic: isClaudeConnected(anthropic),
      },
      email: {
        openai: openai?.email ?? null,
        anthropic: anthropic?.email ?? null,
      },
    });
    setStatusError(errors.find(Boolean) ?? '');
  }, [agentId]);

  useEffect(() => {
    void refreshStatus();
    return () => statusRef.current?.abort();
  }, [refreshStatus]);

  useEffect(() => () => {
    actionRef.current?.abort();
    actionRef.current = null;
  }, []);

  async function setSubscriptionModel(provider: SubscriptionProviderId, signedInEmail: string | null = null) {
    if (actionRef.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    actionRef.current = controller;
    setError('');
    try {
      const result = await setupSubscriptionModel({
        agentId,
        provider,
        email: signedInEmail ?? status?.email[provider] ?? null,
        signal,
        onProgress: (phase) => setAction({ provider, phase }),
      });
      if (signal.aborted) return;
      if (result.kind === 'error' || result.kind === 'terms-required') {
        setError(result.kind === 'error' ? result.message : TERMS_REQUIRED);
        return;
      }
      if (result.kind === 'set') showToast(`${agentName} now uses ${result.name}`, 'success');
      onDone();
    } catch (error) {
      if (!signal.aborted && error instanceof Error && error.name !== 'AbortError') setError(error.message);
    } finally {
      if (actionRef.current === controller) {
        actionRef.current = null;
        setAction(null);
      }
    }
  }

  function connected(provider: SubscriptionProviderId, mustAcceptTerms = false, email: string | null = null) {
    setStatus((current) => current && {
      ...current,
      connected: { ...current.connected, [provider]: true },
      // Keep the signed-in account: a later "Use Claude" runs the terms check against it.
      email: email ? { ...current.email, [provider]: email } : current.email,
    });
    setStatusError('');
    // The Claude sign-in dialog explains the terms itself; closing it re-reads the status.
    if (mustAcceptTerms) return;
    setLogin(null);
    void setSubscriptionModel(provider, email);
  }

  function closeLogin() {
    setLogin(null);
    setError('');
    setStatus(null);
    void refreshStatus();
  }

  const loginView = providers.find(({ provider }) => provider.id === login);
  if (loginView) {
    const { provider, copy } = loginView;
    return provider.loginKind === 'link-code' ? (
      <ClaudeConnectModal agentId={agentId} agentName={agentName} copy={copy} loginPath={provider.loginPath}
        onClose={closeLogin} onConnected={(email, terms) => connected(provider.id, terms, email)} />
    ) : (
      <ConnectModal agentId={agentId} agentName={agentName} provider={provider} copy={copy}
        onClose={closeLogin} onConnected={() => connected(provider.id)} />
    );
  }

  return (
    <Modal open onClose={onClose} title={`Set up the model for ${agentName}`} maxWidth={520}>
      <div style={{ display: 'grid', gap: 12 }}>
        {!status ? (
          <div role="status">Checking subscription support…</div>
        ) : status.unsupported ? (
          <div>Use an API key in the Gateway to set up a model for this agent's OpenClaw version.</div>
        ) : (
          <>
            {statusError && <div role="alert">{statusError}</div>}
            {!status.running && <div>Start this agent to use a subscription.</div>}
            {providers.map(({ provider }) => {
              const loading = action?.provider === provider.id;
              return (
                <div key={provider.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button type="button" variant="primary" loading={loading}
                    disabled={!status.running || action !== null}
                    onClick={() => {
                      if (actionRef.current) return;
                      if (status.connected[provider.id]) void setSubscriptionModel(provider.id);
                      else setLogin(provider.id);
                    }}>
                    {loading
                      ? action.phase === 'waiting' ? "Waiting for the account's models…" : 'Setting the model…'
                      : `${status.connected[provider.id] ? 'Use' : 'Connect'} ${provider.shortName}`}
                  </Button>
                  {provider.experimental && <Pill tone="warning">{EXPERIMENTAL_LABEL}</Pill>}
                </div>
              );
            })}
          </>
        )}
        <div>
          <Button type="button" disabled={action !== null} onClick={() => router.push(`/gateway?agent=${encodeURIComponent(agentId)}`)}>
            Use an API key
          </Button>
        </div>
        {error && (
          <>
            <div role="alert">{error}</div>
            <div>
              <Button type="button" disabled={action !== null} onClick={onChoose}>
                Choose in the Model section
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
