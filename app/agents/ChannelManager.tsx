'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Modal, Tabs, Input, Badge } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';

interface TelegramChannel {
  connected: boolean;
  botToken: string;
  dmPolicy: string;
  allowFrom: string[];
}

interface WhatsAppChannel {
  linked: boolean;
  dmPolicy: string;
  allowFrom: string[];
  selfChatMode: boolean;
  status: string;
}

interface PendingPairing {
  code: string;
  senderId: string | null;
}

interface ApprovedPairing {
  senderId: string;
}

interface ChannelsData {
  agentId: string;
  telegram: TelegramChannel | null;
  whatsapp: WhatsAppChannel | null;
}

interface Props {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}

const PAIRING_POLL_MS = 5000;

export default function ChannelManager({ agentId, agentName, open, onClose }: Props) {
  const [channels, setChannels] = useState<ChannelsData | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [pairingsLoading, setPairingsLoading] = useState(true);
  const [waPairingsLoading, setWaPairingsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [waDisconnecting, setWaDisconnecting] = useState(false);
  const [waLoading, setWaLoading] = useState(false);
  const [approvingCode, setApprovingCode] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [waApprovingCode, setWaApprovingCode] = useState<string | null>(null);
  const [waRevokingId, setWaRevokingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [tgToken, setTgToken] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'revoke'; channel: string; senderId: string } | { type: 'disconnect'; channel: string } | null>(null);

  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [approved, setApproved] = useState<ApprovedPairing[]>([]);
  const [waPending, setWaPending] = useState<PendingPairing[]>([]);
  const [waApproved, setWaApproved] = useState<ApprovedPairing[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingsAbortRef = useRef<AbortController | null>(null);
  const waPairingsAbortRef = useRef<AbortController | null>(null);
  const channelsAbortRef = useRef<AbortController | null>(null);

  const [waChecking, setWaChecking] = useState(false);

  const fetchChannels = useCallback(async () => {
    // Abort any in-flight channels request
    channelsAbortRef.current?.abort();
    const controller = new AbortController();
    channelsAbortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        setChannels(data);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') { /* ignore aborted */ }
    }
    finally { setChannelsLoading(false); }
  }, [agentId]);

  // Shared fetch helper for pairings — cancels previous in-flight request
  const doFetchPairings = useCallback(async (channel: string, showLoading: boolean) => {
    const abortRef = channel === 'whatsapp' ? waPairingsAbortRef : pairingsAbortRef;
    const setData = channel === 'whatsapp'
      ? { setPending: setWaPending, setApproved: setWaApproved, setLoading: setWaPairingsLoading }
      : { setPending: setPending, setApproved: setApproved, setLoading: setPairingsLoading };

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (showLoading) setData.setLoading(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=${channel}`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        setData.setPending(data.pending ?? []);
        setData.setApproved(data.approved ?? []);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') { /* ignore aborted */ }
    }
    finally { if (showLoading) setData.setLoading(false); }
  }, [agentId]);

  const fetchPairings = useCallback(() => doFetchPairings('telegram', true), [doFetchPairings]);
  const pollPairings = useCallback(() => doFetchPairings('telegram', false), [doFetchPairings]);
  const fetchWaPairings = useCallback(() => doFetchPairings('whatsapp', true), [doFetchPairings]);
  const pollWaPairings = useCallback(() => doFetchPairings('whatsapp', false), [doFetchPairings]);

  useEffect(() => {
    if (open) {
      setChannelsLoading(true);
      setPairingsLoading(true);
      setWaPairingsLoading(true);
      setChannels(null);
      setPending([]);
      setApproved([]);
      setWaPending([]);
      setWaApproved([]);
      fetchChannels();
      setError('');
      setSuccess('');
      setTgToken('');
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (waPollRef.current) clearInterval(waPollRef.current);
    };
  }, [open, fetchChannels]);

  // Initial pairings fetch when channels load
  useEffect(() => {
    if (!channelsLoading) {
      if (channels?.telegram?.connected) {
        fetchPairings();
      }
      if (channels?.whatsapp?.linked) {
        fetchWaPairings();
      }
    }
  }, [channelsLoading, channels?.telegram?.connected, channels?.whatsapp?.linked, fetchPairings, fetchWaPairings]);

  // Poll pairings when on the active tab and connected/linked
  useEffect(() => {
    if (open && activeTab === 0 && channels?.telegram?.connected) {
      pollRef.current = setInterval(pollPairings, PAIRING_POLL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, activeTab, channels?.telegram?.connected, pollPairings]);

  useEffect(() => {
    if (open && activeTab === 1 && channels?.whatsapp?.linked) {
      waPollRef.current = setInterval(pollWaPairings, PAIRING_POLL_MS);
    } else {
      if (waPollRef.current) clearInterval(waPollRef.current);
    }
    return () => { if (waPollRef.current) clearInterval(waPollRef.current); };
  }, [open, activeTab, channels?.whatsapp?.linked, pollWaPairings]);

  const handleTelegramConnect = async () => {
    setLoading(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/telegram`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: tgToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to connect Telegram');
      } else {
        setSuccess('Token saved. Restart the agent to activate the bot.');
        setTgToken('');
        setPairingsLoading(true);
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  };

  const handleTelegramDisconnect = async () => {
    setConfirmAction({ type: 'disconnect', channel: 'telegram' });
  };

  const executeDisconnect = async (channel: string) => {
    setConfirmAction(null);
    const isTg = channel === 'telegram';
    const setDisc = isTg ? setDisconnecting : setWaDisconnecting;
    setDisc(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/${channel}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error || `Failed to disconnect ${channel}`);
      } else {
        setSuccess(`${channel === 'telegram' ? 'Telegram' : 'WhatsApp'} disconnected.`);
        if (isTg) setPending([]); else setWaPending([]);
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setDisc(false); }
  };

  const handleRestartAgent = async () => {
    setRestarting(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/restart`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to restart agent');
      } else {
        setSuccess('Agent restarted. The bot is now active. Send /start on Telegram to get a pairing code.');
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setRestarting(false); }
  };

  const handleApprovePairing = async (code: string, channel: string = 'telegram') => {
    const setAppr = channel === 'whatsapp' ? setWaApprovingCode : setApprovingCode;
    setAppr(code); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=${channel}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to approve');
      } else {
        setSuccess(`Pairing ${code} approved.`);
        await doFetchPairings(channel, false);
      }
    } catch { setError('Network error'); }
    finally { setAppr(null); }
  };

  const handleRevokePairing = async (senderId: string, channel: string = 'telegram') => {
    setConfirmAction({ type: 'revoke', channel, senderId });
  };

  const executeRevoke = async (senderId: string, channel: string) => {
    setConfirmAction(null);
    const setRev = channel === 'whatsapp' ? setWaRevokingId : setRevokingId;
    setRev(senderId); setError(''); setSuccess('');
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=${channel}&senderId=${encodeURIComponent(senderId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to revoke');
      } else {
        setSuccess(`Revoked ${senderId}.`);
        await doFetchPairings(channel, false);
      }
    } catch { setError('Network error'); }
    finally { setRev(null); }
  };

  const handleWhatsAppEnable = async () => {
    setWaLoading(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error || 'Failed to enable WhatsApp');
      } else {
        setSuccess('WhatsApp enabled. Now link it from the agent terminal.');
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setWaLoading(false); }
  };

  const handleWhatsAppDisable = async () => {
    setConfirmAction({ type: 'disconnect', channel: 'whatsapp' });
  };

  const handleCheckWhatsAppStatus = async () => {
    setWaChecking(true); setError('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp`);
      if (res.ok) {
        const data = await res.json();
        if (data.linked) {
          setSuccess('WhatsApp is linked!');
        } else {
          setError(data.status || 'WhatsApp is not linked yet');
        }
      }
    } catch { setError('Failed to check status'); }
    finally { setWaChecking(false); fetchChannels(); }
  };

  const tg = channels?.telegram;
  const wa = channels?.whatsapp;

  const tabItems = [
    { label: 'Telegram', active: activeTab === 0, onClick: () => { setActiveTab(0); setError(''); setSuccess(''); } },
    { label: 'WhatsApp', active: activeTab === 1, onClick: () => { setActiveTab(1); setError(''); setSuccess(''); } },
  ];

  return (
    <Modal open={open} onClose={onClose} title={`Channel Manager: ${agentName}`} maxWidth={520}>
      <Tabs items={tabItems} />

      {error && <div style={{ margin: '8px 0' }}><Badge tone="danger">{error}</Badge></div>}
      {success && <div style={{ margin: '8px 0' }}><Badge tone="success">{success}</Badge></div>}

      {/* Confirm modal */}
      <Modal
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title="Confirm"
        maxWidth={340}
        tone="warning"
      >
        <p style={{ fontSize: 12, color: 'var(--text)', margin: '0 0 16px 0' }}>
          {confirmAction?.type === 'revoke'
            ? `Revoke access for sender ${confirmAction.senderId}?`
            : confirmAction?.channel === 'telegram'
              ? 'Disconnect Telegram? All paired users will be removed.'
              : 'Disconnect WhatsApp? The linked session will be logged out and all paired users removed.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (confirmAction?.type === 'revoke') executeRevoke(confirmAction.senderId, confirmAction.channel);
              else if (confirmAction?.type === 'disconnect') executeDisconnect(confirmAction.channel);
            }}
          >
            Confirm
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)}>
            Cancel
          </Button>
        </div>
      </Modal>

      {channelsLoading ? (
        <SkeletonLines count={4} />
      ) : activeTab === 0 ? (
        <TelegramTab
          agentId={agentId}
          tg={tg ?? null}
          tgToken={tgToken}
          setTgToken={setTgToken}
          loading={loading}
          disconnecting={disconnecting}
          pairingsLoading={pairingsLoading}
          restarting={restarting}
          pending={pending}
          approved={approved}
          approvingCode={approvingCode}
          revokingId={revokingId}
          onConnect={handleTelegramConnect}
          onDisconnect={handleTelegramDisconnect}
          onRestart={handleRestartAgent}
          onApprove={(code) => handleApprovePairing(code, 'telegram')}
          onRevoke={(senderId) => handleRevokePairing(senderId, 'telegram')}
        />
      ) : (
        <WhatsAppTab
          agentId={agentId}
          wa={wa ?? null}
          waLoading={waLoading}
          waChecking={waChecking}
          waDisconnecting={waDisconnecting}
          waPending={waPending}
          waApproved={waApproved}
          waPairingsLoading={waPairingsLoading}
          waApprovingCode={waApprovingCode}
          waRevokingId={waRevokingId}
          onEnable={handleWhatsAppEnable}
          onDisable={handleWhatsAppDisable}
          onCheckStatus={handleCheckWhatsAppStatus}
          onApprove={(code) => handleApprovePairing(code, 'whatsapp')}
          onRevoke={(senderId) => handleRevokePairing(senderId, 'whatsapp')}
        />
      )}
    </Modal>
  );
}

// ── Telegram Tab ─────────────────────────────

function TelegramTab({
  agentId: _agentId, tg, tgToken, setTgToken, loading, disconnecting, pairingsLoading, restarting,
  pending, approved, approvingCode, revokingId,
  onConnect, onDisconnect, onRestart, onApprove, onRevoke,
}: {
  agentId: string;
  tg: TelegramChannel | null;
  tgToken: string;
  setTgToken: (v: string) => void;
  loading: boolean;
  disconnecting: boolean;
  pairingsLoading: boolean;
  restarting: boolean;
  pending: PendingPairing[];
  approved: ApprovedPairing[];
  approvingCode: string | null;
  revokingId: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRestart: () => void;
  onApprove: (code: string) => void;
  onRevoke: (senderId: string) => void;
}) {
  if (tg?.connected) {
    return (
      <div>
        <Badge tone="success">Connected &mdash; {tg.botToken} &middot; DM: {tg.dmPolicy}</Badge>

        <div style={{ marginTop: 12 }}>
          <Button variant="secondary" size="sm" loading={restarting} disabled={restarting} onClick={onRestart}>
            {restarting ? 'Restarting…' : 'Restart Agent'}
          </Button>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 10 }}>
            Required after token changes
          </span>
        </div>

        {/* Pairing */}
        <PairingSection
          pending={pending}
          approved={approved}
          pairingsLoading={pairingsLoading}
          approvingCode={approvingCode}
          revokingId={revokingId}
          onApprove={onApprove}
          onRevoke={onRevoke}
        />

        <div style={{ marginTop: 16 }}>
          <Button variant="danger" size="sm" onClick={onDisconnect} loading={disconnecting} disabled={disconnecting}>
            {disconnecting ? 'Disconnecting…' : 'Disconnect Telegram'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        Get a bot token from{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noopener" style={{ color: 'var(--copper)' }}>
          @BotFather
        </a>{' '}
        on Telegram.
      </p>

      <Input
        label="Bot Token"
        type="password"
        value={tgToken}
        onChange={(e) => setTgToken(e.target.value)}
        placeholder="1234567890:ABCdef..."
      />

      <div style={{ marginTop: 12 }}>
        <Button variant="primary" size="sm" onClick={onConnect} loading={loading} disabled={loading || !tgToken.trim()}>
          {loading ? 'Connecting…' : 'Connect Telegram'}
        </Button>
      </div>
    </div>
  );
}

// ── Pairing Section ──────────────────────────

function PairingSection({
  pending, approved, pairingsLoading, approvingCode, revokingId,
  onApprove, onRevoke,
}: {
  pending: PendingPairing[];
  approved: ApprovedPairing[];
  pairingsLoading: boolean;
  approvingCode: string | null;
  revokingId: string | null;
  onApprove: (code: string) => void;
  onRevoke: (senderId: string) => void;
}) {
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{
        fontSize: 10, color: 'var(--copper)', textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 8,
      }}>
        Pairing
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 10px 0' }}>
        Send <code style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--copper)' }}>/start</code> to the bot on Telegram.
      </p>

      {pairingsLoading ? (
        <SkeletonLines count={3} />
      ) : (
        <>
          {/* Pending */}
          {pending.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--yellow)', marginBottom: 6, letterSpacing: '0.04em' }}>PENDING</div>
              {pending.map((p) => (
                <div key={p.code} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 0', borderBottom: '1px solid var(--border)',
                }}>
                  <code style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--blue)', minWidth: 72,
                  }}>{p.code}</code>
                  <Button variant="primary" size="sm" onClick={() => onApprove(p.code)} loading={approvingCode === p.code} disabled={approvingCode !== null}>{approvingCode === p.code ? 'Approving…' : 'Approve'}</Button>
                </div>
              ))}
            </div>
          )}

          {pending.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 12 }}>
              No pending requests
            </div>
          )}

          {/* Approved */}
          {approved.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--green)', marginBottom: 6, letterSpacing: '0.04em' }}>APPROVED</div>
              {approved.map((a) => (
                <div key={a.senderId} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid var(--border)',
                  fontSize: 11,
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                    {a.senderId}
                  </span>
                  <Button variant="danger" size="sm" onClick={() => onRevoke(a.senderId)} loading={revokingId === a.senderId} disabled={revokingId !== null}>{revokingId === a.senderId ? 'Revoking…' : 'Revoke'}</Button>
                </div>
              ))}
            </div>
          )}

          {approved.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              No approved senders
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── WhatsApp Tab ─────────────────────────────

function WhatsAppTab({
  agentId, wa, waLoading, waChecking, waDisconnecting,
  waPending, waApproved, waPairingsLoading, waApprovingCode, waRevokingId,
  onEnable, onDisable, onCheckStatus, onApprove, onRevoke,
}: {
  agentId: string;
  wa: WhatsAppChannel | null;
  waLoading: boolean;
  waChecking: boolean;
  waDisconnecting: boolean;
  waPending: PendingPairing[];
  waApproved: ApprovedPairing[];
  waPairingsLoading: boolean;
  waApprovingCode: string | null;
  waRevokingId: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onCheckStatus: () => void;
  onApprove: (code: string) => void;
  onRevoke: (senderId: string) => void;
}) {
  const [loginQr, setLoginQr] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<'idle' | 'starting' | 'running' | 'linked' | 'error'>('idle');
  const [loginError, setLoginError] = useState('');
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loginAbortRef = useRef<AbortController | null>(null);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => { if (loginPollRef.current) clearInterval(loginPollRef.current); };
  }, []);

  const startLogin = async () => {
    setLoginStatus('starting');
    setLoginError('');
    loginAbortRef.current?.abort();
    const controller = new AbortController();
    loginAbortRef.current = controller;

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp/login`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.qr) {
          setLoginQr(data.qr);
          setLoginStatus('running');
          // Start polling for completion
          loginPollRef.current = setInterval(async () => {
            try {
              const pollRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp/login`);
              if (pollRes.ok) {
                const pollData = await pollRes.json();
                if (pollData.status === 'linked') {
                  setLoginStatus('linked');
                  if (loginPollRef.current) clearInterval(loginPollRef.current);
                  onCheckStatus();
                } else if (pollData.status === 'error' || pollData.status === 'expired') {
                  setLoginStatus('error');
                  setLoginError(pollData.error || 'Login expired or failed');
                  if (loginPollRef.current) clearInterval(loginPollRef.current);
                }
              }
            } catch { /* */ }
          }, 5000);
        }
      } else {
        setLoginStatus('error');
        setLoginError('Failed to start WhatsApp login');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setLoginStatus('error');
        setLoginError('Network error');
      }
    }
  };

  const cancelLogin = async () => {
    if (loginPollRef.current) clearInterval(loginPollRef.current);
    loginAbortRef.current?.abort();
    try {
      await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp/login`, { method: 'DELETE' });
    } catch { /* */ }
    setLoginStatus('idle');
    setLoginQr(null);
    setLoginError('');
  };

  if (wa?.linked) {
    return (
      <div>
        <Badge tone="success">Linked &mdash; DM: {wa.dmPolicy} &middot; Self Chat: {wa.selfChatMode ? 'On' : 'Off'}</Badge>

        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" onClick={onCheckStatus} loading={waChecking}>
            Refresh Status
          </Button>
        </div>

        {/* Pairing */}
        <PairingSection
          pending={waPending}
          approved={waApproved}
          pairingsLoading={waPairingsLoading}
          approvingCode={waApprovingCode}
          revokingId={waRevokingId}
          onApprove={onApprove}
          onRevoke={onRevoke}
        />

        <div style={{ marginTop: 16 }}>
          <Button variant="danger" size="sm" onClick={onDisable} loading={waDisconnecting} disabled={waDisconnecting}>
            {waDisconnecting ? 'Disconnecting…' : 'Disconnect WhatsApp'}
          </Button>
        </div>
      </div>
    );
  }

  // QR Login in progress
  if (loginStatus === 'starting' || loginStatus === 'running') {
    return (
      <div>
        <Badge tone="warning">Link in progress</Badge>

        <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '10px 0' }}>
          Scan this QR code with WhatsApp (Linked Devices &rarr; Link a Device):
        </p>

        {/* QR Code display */}
        {loginQr && (
          <pre style={{
            background: '#000',
            color: '#fff',
            padding: '12px',
            fontSize: '6px',
            lineHeight: 1,
            letterSpacing: 0,
            fontFamily: 'monospace',
            overflow: 'auto',
            maxHeight: 320,
            borderRadius: 0,
            border: '1px solid var(--border)',
            whiteSpace: 'pre',
          }}>
            {loginQr}
          </pre>
        )}

        <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '10px 0' }}>
          {loginStatus === 'starting' ? 'Generating QR code…' : 'Waiting for scan…'}
        </p>

        <Button variant="secondary" size="sm" onClick={cancelLogin}>
          Cancel
        </Button>
      </div>
    );
  }

  // Error state
  if (loginStatus === 'error') {
    return (
      <div>
        <Badge tone="danger">Link failed</Badge>
        {loginError && <p style={{ fontSize: 11, color: 'var(--red)', margin: '10px 0' }}>{loginError}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm" onClick={startLogin}>Retry</Button>
          <Button variant="secondary" size="sm" onClick={cancelLogin}>Go Back</Button>
        </div>
      </div>
    );
  }

  // Linked successfully (transient state before refresh)
  if (loginStatus === 'linked') {
    return (
      <div>
        <Badge tone="success">Linked!</Badge>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '10px 0' }}>
          WhatsApp linked successfully. Refreshing status…
        </p>
        <SkeletonLines count={2} />
      </div>
    );
  }

  // Default: not linked, not started
  return (
    <div>
      <Badge tone="warning">Not Linked</Badge>

      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '10px 0' }}>
        Link WhatsApp by scanning a QR code from your phone.
        Make sure WhatsApp is enabled in the agent config first.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" onClick={onEnable} loading={waLoading} disabled={waLoading}>{waLoading ? 'Enabling…' : 'Enable WhatsApp'}</Button>
        <Button variant="secondary" size="sm" onClick={startLogin} disabled={!wa}>
          Show QR Code
        </Button>
        <Button variant="secondary" size="sm" onClick={onCheckStatus} loading={waChecking}>
          Check Status
        </Button>
      </div>
    </div>
  );
}
