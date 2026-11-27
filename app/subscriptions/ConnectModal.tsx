'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@/app/components/ui';
import type { SubscriptionProvider } from '@/lib/subscription-providers';
import type { SubscriptionProviderCopy } from './providers';

type LoginState = 'starting' | 'waiting' | 'connected' | 'failed' | 'expired' | 'cancelled';
interface Login {
  agentId: string;
  state: LoginState;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  email: string | null;
  error: string | null;
}

/** A JSON body, failing on anything that is not a 2xx (a proxy page parses to {}). */
async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export default function ConnectModal({ provider, copy, agentId, agentName, onClose, onConnected }: {
  provider: SubscriptionProvider;
  copy: SubscriptionProviderCopy;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onConnected: (email: string | null) => void;
}) {
  const [login, setLogin] = useState<Login | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  // The server no longer knows the job (the dashboard restarted while the dialog was open).
  const [lost, setLost] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const announcedRef = useRef(false);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    setLost(false);
    setLogin(null);
    try {
      const json = await readJson<{ login: Login }>(await fetch(provider.loginPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }));
      setLogin(json.login);
    } catch (e) {
      setStartError((e as Error).message);
    }
    setStarting(false);
  }, [agentId, provider.loginPath]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  const active = !lost && !!login && (login.state === 'starting' || login.state === 'waiting');

  // Poll the job every 2 s while it runs; a newer request cancels the one still in flight.
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      pollRef.current?.abort();
      const controller = new AbortController();
      pollRef.current = controller;
      try {
        const res = await fetch(`${provider.loginPath}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.login) setLogin(json.login as Login);
        else if (res.ok && json.login === null) setLost(true);
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') { /* the next tick retries */ }
      }
    };
    const t = setInterval(() => { void tick(); }, 2000);
    return () => { clearInterval(t); pollRef.current?.abort(); };
  }, [active, agentId, provider.loginPath]);

  useEffect(() => {
    if (login?.state !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [login?.state]);

  useEffect(() => {
    if (login?.state === 'connected' && !announcedRef.current) {
      announcedRef.current = true;
      onConnected(login.email);
    }
  }, [login, onConnected]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await fetch(`${provider.loginPath}?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch { /* the in-container timeout is the backstop */ }
    setCancelling(false);
    onClose();
  };

  const close = () => { if (cancelling || starting) return; if (active) void cancel(); else onClose(); };

  const copyCode = async () => {
    if (!login?.code) return;
    try {
      await navigator.clipboard.writeText(login.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the code is on screen to copy by hand */ }
  };

  const remaining = login?.expiresAt ? Math.max(0, Math.floor((login.expiresAt - now) / 1000)) : null;
  const mmss = remaining === null ? '' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  const failedState = startError || lost || (login && (login.state === 'failed' || login.state === 'expired' || login.state === 'cancelled'));

  return (
    <Modal open onClose={close} title={copy.connectTitle(agentName)} maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
        {(starting || login?.state === 'starting') && !startError && (
          <div style={{ color: 'var(--text-dim, #888)' }}>Waiting for the agent…</div>
        )}

        {!lost && login?.state === 'waiting' && (
          <>
            <div>
              1. Open{' '}
              <a href={login.url ?? '#'} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)' }}>
                {login.url}
              </a>
            </div>
            <div>
              <div style={{ marginBottom: 6 }}>2. Enter this code:</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 28, fontFamily: 'monospace', letterSpacing: '0.12em', fontWeight: 700 }}>{login.code}</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => { void copyCode(); }}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>
              {copy.codeHint}
              {remaining !== null && <> Time left: <strong>{mmss}</strong>.</>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>{copy.waiting}</div>
          </>
        )}

        {!lost && login?.state === 'connected' && (
          <div style={{ color: 'var(--green)' }}>Connected{login.email ? ` as ${login.email}` : ''}.</div>
        )}

        {failedState && (
          <div style={{ color: !lost && login?.state === 'cancelled' ? 'var(--text-dim, #888)' : 'var(--red)' }}>
            {startError ?? (lost ? 'The login was interrupted. Start again.' : null) ?? login?.error ?? (login?.state === 'cancelled' ? 'Cancelled.' : 'The login did not complete.')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {failedState && (
            <Button type="button" variant="primary" size="sm" loading={starting} disabled={starting} onClick={() => { void start(); }}>
              {starting ? 'Starting…' : lost ? 'Start again' : 'Retry'}
            </Button>
          )}
          {active ? (
            <Button type="button" variant="secondary" size="sm" loading={cancelling} disabled={cancelling} onClick={() => { void cancel(); }}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" disabled={starting} onClick={onClose}>
              {login?.state === 'connected' ? 'Done' : 'Close'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
