'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Modal, Input, Badge } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';

interface TelegramChannel {
  connected: boolean;
  botToken: string;
  dmPolicy: string;
  allowFrom: string[];
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
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [approvingCode, setApprovingCode] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [tgToken, setTgToken] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'revoke'; channel: string; senderId: string } | { type: 'disconnect'; channel: string } | null>(null);

  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [approved, setApproved] = useState<ApprovedPairing[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingsAbortRef = useRef<AbortController | null>(null);
  const channelsAbortRef = useRef<AbortController | null>(null);

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
  const doFetchPairings = useCallback(async (showLoading: boolean) => {
    pairingsAbortRef.current?.abort();
    const controller = new AbortController();
    pairingsAbortRef.current = controller;
    if (showLoading) setPairingsLoading(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=telegram`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        setPending(data.pending ?? []);
        setApproved(data.approved ?? []);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') { /* ignore aborted */ }
    }
    finally { if (showLoading) setPairingsLoading(false); }
  }, [agentId]);

  const fetchPairings = useCallback(() => doFetchPairings(true), [doFetchPairings]);
  const pollPairings = useCallback(() => doFetchPairings(false), [doFetchPairings]);

  useEffect(() => {
    if (open) {
      setChannelsLoading(true);
      setPairingsLoading(true);
      setChannels(null);
      setPending([]);
      setApproved([]);
      fetchChannels();
      setError('');
      setSuccess('');
      setTgToken('');
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      channelsAbortRef.current?.abort();
      pairingsAbortRef.current?.abort();
    };
  }, [open, fetchChannels]);

  // Initial pairings fetch when channels load
  useEffect(() => {
    if (!channelsLoading && channels?.telegram?.connected) {
      fetchPairings();
    }
  }, [channelsLoading, channels?.telegram?.connected, fetchPairings]);

  // Poll pairings when on the active tab and connected/linked
  useEffect(() => {
    if (open && channels?.telegram?.connected) {
      pollRef.current = setInterval(pollPairings, PAIRING_POLL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, channels?.telegram?.connected, pollPairings]);

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

  const executeDisconnect = async (_channel: string) => {
    setConfirmAction(null);
    setDisconnecting(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/telegram`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error || 'Failed to disconnect Telegram');
      } else {
        setSuccess('Telegram disconnected.');
        setPending([]);
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setDisconnecting(false); }
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

  const handleApprovePairing = async (code: string) => {
    setApprovingCode(code); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to approve');
      } else {
        setSuccess(`Pairing ${code} approved.`);
        await doFetchPairings(false);
      }
    } catch { setError('Network error'); }
    finally { setApprovingCode(null); }
  };

  const handleRevokePairing = async (senderId: string) => {
    setConfirmAction({ type: 'revoke', channel: 'telegram', senderId });
  };

  const executeRevoke = async (senderId: string, _channel: string) => {
    setConfirmAction(null);
    setRevokingId(senderId); setError(''); setSuccess('');
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/channels/pairing?channel=telegram&senderId=${encodeURIComponent(senderId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to revoke');
      } else {
        setSuccess(`Revoked ${senderId}.`);
        await doFetchPairings(false);
      }
    } catch { setError('Network error'); }
    finally { setRevokingId(null); }
  };

  const tg = channels?.telegram;

  return (
    <Modal open={open} onClose={onClose} title={`Channel Manager: ${agentName}`} maxWidth={520}>

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
            : 'Disconnect Telegram? All paired users will be removed.'}
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
      ) : (
        <TelegramTab
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
          onApprove={handleApprovePairing}
          onRevoke={handleRevokePairing}
        />
      )}
    </Modal>
  );
}

// ── Telegram Tab ─────────────────────────────

function TelegramTab({
  tg, tgToken, setTgToken, loading, disconnecting, pairingsLoading, restarting,
  pending, approved, approvingCode, revokingId,
  onConnect, onDisconnect, onRestart, onApprove, onRevoke,
}: {
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
