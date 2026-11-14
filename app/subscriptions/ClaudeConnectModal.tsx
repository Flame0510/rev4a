'use client';

/**
 * The guided sign-in dialog of a `link-code` subscription provider (today Claude through Claude
 * Code): the operator signs in on the provider's own page and pastes back the code it shows.
 *
 * It is built only from the shared UI primitives (`Modal`, `Button`, `Input`, `LoadingSpinner`).
 * The code lives in component state for as long as it takes to POST it and is then dropped: it is
 * never written to localStorage, the URL, a log or a toast.
 *
 * The dialog follows the server's login job: `starting` → `installing` (first time only) →
 * `waiting` (link and prompt) → `verifying` → `connecting` → `connected`, or `failed`/`expired`.
 * It polls `GET <loginPath>?agentId=` every 2 s while the job is active, one request at a time,
 * with an `AbortController` ref (AGENTS.md §2.2b rule 10). Closing while the job is active cancels
 * it with `DELETE`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, LoadingSpinner, Modal } from '@/app/components/ui';
import type { SubscriptionProviderCopy } from './providers';
import { linkCodeStep } from './providers';

type LoginState = 'starting' | 'installing' | 'waiting' | 'verifying' | 'connecting' | 'connected' | 'failed' | 'expired' | 'cancelled';

interface Login {
  agentId: string;
  state: LoginState;
  url: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
}

const ACTIVE: readonly LoginState[] = ['starting', 'installing', 'waiting', 'verifying', 'connecting'];
const POLL_MS = 2000;

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export default function ClaudeConnectModal({ agentId, agentName, copy, loginPath, onClose, onConnected }: {
  agentId: string;
  agentName: string;
  copy: SubscriptionProviderCopy;
  /** The provider's login route (`…/login`); the code route is `<loginPath>/code`. */
  loginPath: string;
  onClose: () => void;
  onConnected: (email: string | null) => void;
}) {
  const text = copy.linkCode;
  if (!text) throw new Error('The Claude sign-in dialog needs link-code copy.');

  const [login, setLogin] = useState<Login | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  /** The server no longer knows the job (the dashboard restarted while the dialog was open). */
  const [lost, setLost] = useState(false);
  const pollRef = useRef<AbortController | null>(null);
  /** The first start POST can be aborted while it is pending (Close, Escape, Cancel). */
  const startRef = useRef<AbortController | null>(null);
  /**
   * A poll that was already in flight when the code was submitted can land after the POST answer
   * and put the view back to `waiting`. Every applied state change bumps this number; a poll answer
   * that captured an older one is dropped.
   */
  const stateSeqRef = useRef(0);
  const startedRef = useRef(false);
  const announcedRef = useRef(false);

  const start = useCallback(async () => {
    // A second start (Start again) supersedes a first one still in flight.
    startRef.current?.abort();
    const controller = new AbortController();
    startRef.current = controller;
    const deadline = setTimeout(() => controller.abort(), 20_000);
    setStarting(true);
    setStartError(null);
    setLost(false);
    setLogin(null);
    setCode('');
    setCodeError(null);
    try {
      const json = await readJson<{ login: Login }>(await fetch(loginPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
        signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      stateSeqRef.current++;
      setLogin(json.login);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        // A timeout with this start still current: the operator sees a failure, not a stuck spinner.
        if (startRef.current === controller) {
          setStartError(text.failed);
          // The server may have created the job after the deadline: delete it (a placeholder or a
          // running job is cancelled; harmless when there is none).
          void fetch(`${loginPath}?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }).catch(() => { /* best effort */ });
        }
      } else {
        setStartError((e as Error).message);
      }
    } finally {
      clearTimeout(deadline);
    }
    if (startRef.current === controller) setStarting(false);
  }, [agentId, loginPath, text.failed]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Leaving the dialog aborts a first start that is still waiting for its answer.
  useEffect(() => () => { startRef.current?.abort(); }, []);

  const active = !lost && !!login && ACTIVE.includes(login.state);

  // One poll at a time: the next request is scheduled only after the previous one answered.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      pollRef.current?.abort();
      const controller = new AbortController();
      pollRef.current = controller;
      const seq = stateSeqRef.current;
      try {
        const res = await fetch(`${loginPath}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (stopped || controller.signal.aborted) return;
        // Never let a poll that started before a submit overwrite the newer state the submit applied.
        if (seq === stateSeqRef.current) {
          if (res.ok && json.login) {
            stateSeqRef.current++;
            setLogin(json.login as Login);
          } else if (res.ok && json.login === null) setLost(true);
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // The next tick retries; the job's own deadline is the backstop.
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, POLL_MS);
    };
    timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      pollRef.current?.abort();
    };
  }, [active, agentId, loginPath]);

  useEffect(() => {
    if (login?.state === 'connected' && !announcedRef.current) {
      announcedRef.current = true;
      onConnected(login.email);
    }
  }, [login, onConnected]);

  const cancel = async () => {
    // The first start POST may still be pending: abort it, and delete the job it may already have
    // created — the server keeps the job keyed by agent id, so no id is needed.
    if (starting) {
      startRef.current?.abort();
      startRef.current = null;
      void fetch(`${loginPath}?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }).catch(() => { /* best effort */ });
      onClose();
      return;
    }
    setCancelling(true);
    try {
      await fetch(`${loginPath}?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch { /* the in-container timeout is the backstop */ }
    setCancelling(false);
    onClose();
  };

  const close = () => {
    if (cancelling) return;
    // The code is in: the job finishes on its own and a cancel would change nothing on the server.
    // Closing only hides the dialog; the page refreshes the row.
    if (finishing) { onClose(); return; }
    if (active || starting) void cancel();
    else onClose();
  };

  const submit = async () => {
    const value = code;
    // The typed code leaves the input at once, whatever the answer: it is never kept anywhere.
    setCode('');
    setCodeError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${loginPath}/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, code: value }),
      });
      const json = (await res.json().catch(() => ({}))) as { login?: Login; error?: string };
      if (res.ok && json.login) {
        // This answer is newer than any poll that started before it: drop their late answers.
        stateSeqRef.current++;
        setLogin(json.login);
      } else if (res.status === 400) setCodeError(text.invalidCode);
      else setCodeError(typeof json.error === 'string' ? json.error : text.failed);
    } catch {
      setCodeError(text.failed);
    }
    setSubmitting(false);
  };

  const step = startError || lost ? 'failed' : login ? linkCodeStep(login.state) : 'starting';
  /** The code was submitted: the server finishes the job itself, so there is nothing left to cancel. */
  const finishing = step === 'verifying' || step === 'connecting';
  const openSignIn = () => {
    if (!login?.url) return;
    window.open(login.url, '_blank', 'noopener,noreferrer');
  };
  // Copy Anthropic's link, to open it in another browser or on another device. The clipboard can be
  // refused (plain HTTP from another machine): then the link is shown read-only to copy by hand.
  const copyLink = async () => {
    if (!login?.url) return;
    try {
      await navigator.clipboard.writeText(login.url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      setShowLink(true);
    }
  };

  return (
    <Modal open onClose={close} title={copy.connectTitle(agentName)} maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
        {step === 'starting' && <LoadingSpinner compact label={text.starting} />}
        {step === 'installing' && <LoadingSpinner compact label={text.installing} />}

        {step === 'waiting' && !lost && login && (
          <>
            <div>
              <div style={{ marginBottom: 6 }}>1. {text.signInStep}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button type="button" variant="secondary" size="sm" disabled={!login.url || submitting} onClick={openSignIn}>
                  {text.openSignIn}
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={!login.url || submitting} onClick={() => { void copyLink(); }}>
                  {linkCopied ? text.linkCopied : text.copyLink}
                </Button>
              </div>
              {showLink && login.url && (
                <div style={{ marginTop: 8 }}>
                  <Input label={text.copyLinkByHand} value={login.url} readOnly onFocus={(e) => e.currentTarget.select()} />
                </div>
              )}
            </div>
            <div>
              <div style={{ marginBottom: 6 }}>2. {text.pasteCodeStep}</div>
              <Input
                label={text.codeFieldLabel}
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && code && !submitting) void submit(); }}
              />
              <div style={{ marginTop: 8 }}>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  loading={submitting}
                  disabled={!code || submitting}
                  onClick={() => { void submit(); }}
                >
                  {submitting ? text.checking : text.continueAction}
                </Button>
              </div>
              {codeError && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>{codeError}</div>}
            </div>
          </>
        )}

        {step === 'verifying' && <LoadingSpinner compact label={text.verifying} />}
        {step === 'connecting' && <LoadingSpinner compact label={text.connecting} />}

        {step === 'connected' && login && (
          <>
            <div style={{ color: 'var(--green)' }}>
              {text.connected}
              {login.email ? ` · ${login.email}${login.plan ? ` · ${login.plan}` : ''}` : login.plan ? ` · ${login.plan}` : ''}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim, #888)' }}>{text.connectedHint}</div>
          </>
        )}

        {step === 'failed' && (
          <div style={{ color: 'var(--red)' }}>
            {startError ?? (lost ? text.interrupted : null) ?? login?.error ?? text.failed}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {step === 'failed' && (
            <Button type="button" variant="primary" size="sm" loading={starting} disabled={starting} onClick={() => { void start(); }}>
              {starting ? text.starting : text.startAgain}
            </Button>
          )}
          {step === 'connected' ? (
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              {text.done}
            </Button>
          ) : step === 'failed' ? (
            <Button type="button" variant="secondary" size="sm" disabled={starting} onClick={onClose}>
              {text.close}
            </Button>
          ) : finishing ? null : (
            <Button
              type="button" variant="secondary" size="sm"
              loading={cancelling}
              disabled={cancelling || submitting}
              onClick={() => { void cancel(); }}
            >
              {cancelling ? text.cancelling : text.cancel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
