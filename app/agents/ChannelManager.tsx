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
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [waLoading, setWaLoading] = useState(false);
  const [approvingCode, setApprovingCode] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [tgToken, setTgToken] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'revoke'; senderId: string } | { type: 'disconnect' } | null>(null);

  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [approved, setApproved] = useState<ApprovedPairing[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [waChecking, setWaChecking] = useState(false);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels`);
      if (res.ok) {
        const data = await res.json();
        setChannels(data);
      }
    } catch { /* */ }
    finally { setChannelsLoading(false); }
  }, [agentId]);

  const fetchPairings = useCallback(async () => {
    setPairingsLoading(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing`);
      if (res.ok) {
        const data = await res.json();
        setPending(data.pending ?? []);
        setApproved(data.approved ?? []);
      }
    } catch { /* */ }
    finally { setPairingsLoading(false); }
  }, []);

  const pollPairings = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing`);
      if (res.ok) {
        const data = await res.json();
        setPending(data.pending ?? []);
        setApproved(data.approved ?? []);
      }
    } catch { /* */ }
  }, [agentId]);

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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, fetchChannels]);

  // Initial pairings fetch when channels load and telegram is connected
  useEffect(() => {
    if (!channelsLoading && channels?.telegram?.connected) {
      fetchPairings();
    }
  }, [channelsLoading, channels?.telegram?.connected, fetchPairings]);

  // Poll pairings when on Telegram tab and connected
  useEffect(() => {
    if (open && activeTab === 0 && channels?.telegram?.connected) {
      pollRef.current = setInterval(pollPairings, PAIRING_POLL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, activeTab, channels?.telegram?.connected, pollPairings]);

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
    setConfirmAction({ type: 'disconnect' });
  };

  const executeDisconnect = async () => {
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
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to approve');
      } else {
        setSuccess(`Pairing ${code} approved.`);
        await fetchPairings();
      }
    } catch { setError('Network error'); }
    finally { setApprovingCode(null); }
  };

  const handleRevokePairing = async (senderId: string) => {
    setConfirmAction({ type: 'revoke', senderId });
  };

  const executeRevoke = async (senderId: string) => {
    setConfirmAction(null);
    setRevokingId(senderId); setError(''); setSuccess('');
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/channels/pairing?senderId=${encodeURIComponent(senderId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to revoke');
      } else {
        setSuccess(`Revoked ${senderId}.`);
        await fetchPairings();
      }
    } catch { setError('Network error'); }
    finally { setRevokingId(null); }
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
    setWaLoading(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/channels/whatsapp`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error || 'Failed to disable WhatsApp');
      } else {
        setSuccess('WhatsApp disabled.');
        fetchChannels();
      }
    } catch { setError('Network error'); }
    finally { setWaLoading(false); }
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
            : 'Disconnect Telegram? All paired users will be removed.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant={confirmAction?.type === 'revoke' ? 'danger' : 'danger'}
            size="sm"
            onClick={() => {
              if (confirmAction?.type === 'revoke') executeRevoke(confirmAction.senderId);
              else if (confirmAction?.type === 'disconnect') executeDisconnect();
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
          onApprove={handleApprovePairing}
          onRevoke={handleRevokePairing}
        />
      ) : (
        <WhatsAppTab
          agentId={agentId}
          wa={wa ?? null}
          waLoading={waLoading}
          waChecking={waChecking}
          onEnable={handleWhatsAppEnable}
          onDisable={handleWhatsAppDisable}
          onCheckStatus={handleCheckWhatsAppStatus}
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
  agentId, wa, waLoading, waChecking,
  onEnable, onDisable, onCheckStatus,
}: {
  agentId: string;
  wa: WhatsAppChannel | null;
  waLoading: boolean;
  waChecking: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onCheckStatus: () => void;
}) {
  if (wa?.linked) {
    return (
      <div>
        <Badge tone="success">Linked &mdash; DM: {wa.dmPolicy} &middot; Self Chat: {wa.selfChatMode ? 'On' : 'Off'}</Badge>

        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" onClick={onCheckStatus} loading={waChecking}>
            Refresh Status
          </Button>
          <Button variant="danger" size="sm" onClick={onDisable} loading={waLoading} disabled={waLoading}>{waLoading ? 'Disabling…' : 'Disable WhatsApp'}</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Badge tone="warning">Not Linked</Badge>

      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '10px 0' }}>
        WhatsApp uses QR-based linking. Enable WhatsApp in the agent config,
        then run the link command from a terminal:
      </p>

      <div style={{
        padding: '8px 12px',
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        fontSize: 11, fontFamily: 'var(--font-mono)',
        color: 'var(--blue)', wordBreak: 'break-all',
        marginBottom: 10,
      }}>
        docker exec -it {agentId} openclaw channels login --channel whatsapp
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        Scan the QR code with WhatsApp (Linked Devices &rarr; Link a Device).
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" onClick={onEnable} loading={waLoading} disabled={waLoading}>{waLoading ? 'Enabling…' : 'Enable WhatsApp'}</Button>
        <Button variant="secondary" size="sm" onClick={onCheckStatus} loading={waChecking}>
          Check Status
        </Button>
      </div>
    </div>
  );
}
