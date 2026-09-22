'use client';

/**
 * Browser access to an agent's Control UI, in its detail panel.
 *
 * From OpenClaw 9.x every new browser must be approved once before the Control UI
 * connects. This section lists the requests waiting for approval and the browsers
 * already approved, with approve, reject, rename and revoke. Agents created on
 * Every supported agent lists its browsers through the CLI.
 *
 * `OpenControlUiButton` opens the Control UI through a one-time link that pairs the
 * browser with no approval, or through the plain token link when no one-time link can
 * be issued.
 *
 * Data comes from `/api/agents/[id]/devices`, which runs the OpenClaw CLI inside the
 * container. It refreshes every few seconds only while this section is mounted.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, ConfirmModal, Input, RemoveButton } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';

interface PendingBrowser {
  requestId: string;
  deviceId: string;
  displayName: string | null;
  platform: string | null;
  clientId: string | null;
  clientMode: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  browserOrigin: string | null;
  isRepair: boolean;
  requestedAtMs: number | null;
}

interface ApprovedBrowser {
  deviceId: string;
  label: string | null;
  platform: string | null;
  clientId: string | null;
  clientMode: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  approvedVia: string | null;
  createdAtMs: number | null;
  approvedAtMs: number | null;
  lastUsedAtMs: number | null;
}

interface AccessState {
  running: boolean;
  requiresApproval: boolean | null;
  pending: PendingBrowser[];
  approved: ApprovedBrowser[];
}

interface InviteLink {
  url: string;
  /** The dashboard is reached on localhost: nobody else can use the link. */
  loopbackHost: boolean;
}

const POLL_MS = 5_000;

const APPROVED_VIA: Record<string, string> = {
  silent: 'automatically (local connection)',
  owner: 'by an operator',
  bootstrap: 'through a one-time link',
  'ssh-verified': 'SSH-verified',
  'trusted-proxy': 'by the trusted proxy',
  'trusted-cidr': 'from a trusted network',
};

function ago(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

function clientLabel(clientId: string | null): string {
  if (clientId === 'openclaw-control-ui') return 'Control UI';
  if (clientId === 'cli') return 'CLI';
  return clientId ?? 'Unknown client';
}

function accessLabel(scopes: string[]): string {
  if (scopes.includes('operator.admin')) return 'admin';
  if (scopes.includes('operator.write')) return 'read & write';
  return scopes.length ? 'read only' : 'no access';
}

const join = (parts: (string | null | false)[]) => parts.filter(Boolean).join(' · ');

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
  borderTop: '1px solid var(--border)', flexWrap: 'wrap',
};
const titleStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-dim)', letterSpacing: 0.5, margin: '10px 0 2px' };
const metaStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-word' };

/**
 * Opens the agent's Control UI in a new tab, inside the click.
 *
 * The tab goes straight to `/api/agents/[id]/open-control-ui`, which redirects to a
 * one-time link or to the plain token link. Resolving the target server-side keeps
 * this a plain navigation: no blank tab to fill in after an `await`, nothing for a
 * popup blocker to stop.
 */
export function OpenControlUiButton({
  agentId,
  label = 'Open ↗',
  variant = 'primary',
  stopPropagation = false,
}: {
  agentId: string;
  label?: string;
  variant?: 'primary' | 'secondary';
  /** For buttons inside a clickable row. */
  stopPropagation?: boolean;
}) {
  const open = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    window.open(`/api/agents/${encodeURIComponent(agentId)}/open-control-ui`, '_blank', 'noopener');
  };

  return (
    <Button variant={variant} size="sm" onClick={open} title="Open the agent Control UI">
      {label}
    </Button>
  );
}

export default function BrowserAccessSection({
  agentId,
  running,
  onChanged,
}: {
  agentId: string;
  running: boolean;
  /** After a successful approve, reject or revoke, so the list can refresh its badge. */
  onChanged?: () => void;
}) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<{ deviceId: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<ApprovedBrowser | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const inviteAbortRef = useRef<AbortController | null>(null);
  const inviteInputId = useId();

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/devices`, { signal: controller.signal });
      if (abortRef.current !== controller) return;
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setLoadError(data?.error ?? `Could not load browser access (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as AccessState;
      // A read that started before a mutation must not bring back what it removed.
      if (abortRef.current !== controller) return;
      setAccess(data);
      setLoadError(null);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError' && abortRef.current === controller) {
        setLoadError('Could not load browser access');
      }
    }
  }, [agentId]);

  useEffect(() => {
    setAccess(null);
    setLoadError(null);
    setMsg(null);
    setRenaming(null);
    setInvite(null);
    setCopied(null);
    void load();
    // One request at a time: `load()` runs the OpenClaw CLI inside the container and can
    // take seconds on a slow agent, so the next tick waits for the previous response
    // instead of an interval stacking calls on top of each other.
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await load();
      if (alive) timer = setTimeout(() => { void tick(); }, POLL_MS);
    };
    if (running) timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
      inviteAbortRef.current?.abort();
    };
  }, [load, running]);

  /**
   * Runs one mutation at a time; refreshes afterwards without holding the lock.
   * `applyLocally` updates the list as soon as the mutation succeeds, because the
   * refresh runs the OpenClaw CLI and takes seconds.
   */
  const mutate = async (
    key: string,
    doneText: string,
    request: () => Promise<Response>,
    applyLocally?: (current: AccessState) => AccessState,
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = key;
    setBusy(key);
    setMsg(null);
    let ok = false;
    try {
      const res = await request();
      if (res.ok) {
        ok = true;
        if (applyLocally) setAccess((current) => (current ? applyLocally(current) : current));
        setMsg({ text: doneText, ok: true });
        onChanged?.();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg({ text: data?.error ?? `Request failed (HTTP ${res.status})`, ok: false });
      }
    } catch {
      setMsg({ text: 'Request failed', ok: false });
    }
    busyRef.current = null;
    setBusy(null);
    void load();
    return ok;
  };

  const base = `/api/agents/${encodeURIComponent(agentId)}/devices`;
  const json = { 'Content-Type': 'application/json' };

  const decide = (r: PendingBrowser, action: 'approve' | 'reject') =>
    mutate(
      `${action}:${r.requestId}`,
      action === 'approve' ? 'Browser approved.' : 'Request rejected.',
      () => fetch(base, { method: 'POST', headers: json, body: JSON.stringify({ action, requestId: r.requestId }) }),
      (current) => ({ ...current, pending: current.pending.filter((p) => p.requestId !== r.requestId) }),
    );

  const saveRename = async () => {
    if (!renaming) return;
    const { deviceId, name } = renaming;
    const saved = await mutate(
      `rename:${deviceId}`,
      'Name saved.',
      () => fetch(base, { method: 'PATCH', headers: json, body: JSON.stringify({ deviceId, name }) }),
      (current) => ({
        ...current,
        approved: current.approved.map((d) => (d.deviceId === deviceId ? { ...d, label: name.trim() } : d)),
      }),
    );
    if (saved) setRenaming(null);
  };

  const revoke = (d: ApprovedBrowser) =>
    mutate(
      `revoke:${d.deviceId}`,
      'Browser access revoked.',
      () => fetch(`${base}?deviceId=${encodeURIComponent(d.deviceId)}`, { method: 'DELETE' }),
      (current) => ({ ...current, approved: current.approved.filter((a) => a.deviceId !== d.deviceId) }),
    );

  const createInvite = async () => {
    if (busyRef.current) return;
    busyRef.current = 'invite';
    setBusy('invite');
    setMsg(null);
    setCopied(null);
    inviteAbortRef.current?.abort();
    const controller = new AbortController();
    inviteAbortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/invite-link`, { signal: controller.signal, cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as (InviteLink & { error?: string }) | null;
      if (res.ok && data?.url) setInvite(data);
      else setMsg({ text: data?.error ?? `Could not create the invite link (HTTP ${res.status})`, ok: false });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setMsg({ text: 'Could not create the invite link', ok: false });
    }
    busyRef.current = null;
    setBusy(null);
  };

  /**
   * The Clipboard API exists only in a secure context, and Rev4a is often reached over
   * plain HTTP; the fallback copies the selected text of the link field.
   */
  const copyInvite = async () => {
    if (!invite) return;
    let ok = false;
    if (window.isSecureContext && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(invite.url);
        ok = true;
      } catch {
        // Fall back to the selection below.
      }
    }
    if (!ok) {
      const field = document.getElementById(inviteInputId) as HTMLInputElement | null;
      if (field) {
        field.focus();
        field.select();
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
      }
    }
    setCopied(ok);
  };

  if (!running) {
    return <div style={metaStyle}>Start the agent to see and manage the browsers that can open its Control UI.</div>;
  }

  return (
    <div>
      {msg && (
        <div style={{ margin: '6px 0' }}>
          <Badge tone={msg.ok ? 'success' : 'danger'}><span style={{ fontSize: 10 }}>{msg.text}</span></Badge>
        </div>
      )}
      {loadError && (
        <div style={{ margin: '6px 0' }}>
          <Badge tone="danger"><span style={{ fontSize: 10 }}>{loadError}</span></Badge>
        </div>
      )}

      {access === null && !loadError && <SkeletonLines count={3} />}

      {access?.requiresApproval === false && (
        <div style={metaStyle}>
          This agent could not be read: its Control UI may open with the token alone,
          so there is nothing to approve.
        </div>
      )}

      {access?.requiresApproval === true && (
        <div style={{ margin: '8px 0' }}>
          {!invite ? (
            <Button variant="secondary" size="sm" loading={busy === 'invite'} disabled={busy !== null} onClick={() => { void createInvite(); }}>
              {busy === 'invite' ? 'Creating…' : 'Invite link'}
            </Button>
          ) : (
            <>
              <div style={titleStyle}>INVITE LINK</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <Input id={inviteInputId} aria-label="Invite link" readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} />
                </div>
                <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => { void copyInvite(); }}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setInvite(null); setCopied(null); }}>
                  Hide
                </Button>
              </div>
              {copied === false && (
                <div style={{ margin: '6px 0' }}>
                  <Badge tone="danger"><span style={{ fontSize: 10 }}>The browser blocked copying: the link is selected, press Ctrl+C or ⌘C.</span></Badge>
                </div>
              )}
              {invite.loopbackHost && (
                <div style={{ margin: '6px 0' }}>
                  <Badge tone="warning">
                    <span style={{ fontSize: 10 }}>This link uses localhost, which nobody else can reach. Open Rev4a on the address they will use and create the link again.</span>
                  </Badge>
                </div>
              )}
              <div style={metaStyle}>
                Send it to the person you want to let in. Their browser shows up under Waiting for approval, and nothing
                opens until you approve it. Ask them to use a normal window: a private window forgets the approval when it closes.
              </div>
              <div style={metaStyle}>
                The link carries the gateway token that every agent shares. To stop all links sent so far, change the
                agents token: running agents restart with the new one.
              </div>
            </>
          )}
        </div>
      )}

      {access && access.requiresApproval !== false && (
        <>
          {access.pending.length > 0 && (
            <>
              <div style={titleStyle}>WAITING FOR APPROVAL ({access.pending.length})</div>
              {access.pending.map((r) => {
                const approveKey = `approve:${r.requestId}`;
                const rejectKey = `reject:${r.requestId}`;
                return (
                  <div key={r.requestId} style={rowStyle}>
                    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text)' }}>
                        {join([r.displayName ?? clientLabel(r.clientId), r.platform])}
                      </div>
                      <div style={metaStyle}>
                        {join([r.remoteIp, r.browserOrigin, `asked ${ago(r.requestedAtMs)}`, accessLabel(r.scopes), r.isRepair && 'asks for broader access'])}
                      </div>
                    </div>
                    <Button variant="success" size="sm" loading={busy === approveKey} disabled={busy !== null} onClick={() => { void decide(r, 'approve'); }}>
                      {busy === approveKey ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button variant="secondary" size="sm" loading={busy === rejectKey} disabled={busy !== null} onClick={() => { void decide(r, 'reject'); }}>
                      {busy === rejectKey ? 'Rejecting…' : 'Reject'}
                    </Button>
                  </div>
                );
              })}
            </>
          )}

          <div style={titleStyle}>APPROVED BROWSERS ({access.approved.length})</div>
          {access.approved.length === 0 && <div style={metaStyle}>No browser has been approved yet.</div>}
          {access.approved.map((d) => {
            const name = d.label ?? `${clientLabel(d.clientId)} ${d.deviceId.slice(0, 8)}`;
            const renameKey = `rename:${d.deviceId}`;
            const revokeKey = `revoke:${d.deviceId}`;
            const isRenaming = renaming?.deviceId === d.deviceId;
            return (
              <div key={d.deviceId} style={{ ...rowStyle, opacity: busy === revokeKey ? 0.6 : 1 }}>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  {isRenaming ? (
                    <Input
                      aria-label={`New name for ${name}`}
                      value={renaming.name}
                      maxLength={64}
                      autoFocus
                      onChange={(e) => setRenaming({ deviceId: d.deviceId, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text)' }}>{name}</div>
                  )}
                  <div style={metaStyle}>
                    {join([clientLabel(d.clientId), d.platform, d.remoteIp, accessLabel(d.scopes)])}
                  </div>
                  <div style={metaStyle}>
                    {join([
                      `approved ${d.approvedVia ? APPROVED_VIA[d.approvedVia] ?? d.approvedVia : ''} ${ago(d.approvedAtMs ?? d.createdAtMs)}`.replace(/\s+/g, ' '),
                      `last used ${ago(d.lastUsedAtMs)}`,
                      busy === revokeKey && 'Revoking…',
                    ])}
                  </div>
                </div>
                {isRenaming ? (
                  <>
                    <Button variant="primary" size="sm" loading={busy === renameKey} disabled={busy !== null || !renaming.name.trim()} onClick={() => { void saveRename(); }}>
                      {busy === renameKey ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setRenaming({ deviceId: d.deviceId, name: d.label ?? '' })}>
                      Rename
                    </Button>
                    <RemoveButton label={name} title={`Revoke access for ${name}`} disabled={busy !== null} onClick={() => setRevoking(d)} />
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      <ConfirmModal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          const target = revoking;
          setRevoking(null);
          if (target) void revoke(target);
        }}
        title={`Revoke ${revoking?.label ?? 'this browser'}?`}
        message="This browser loses access to the Control UI and needs approval again the next time it connects."
        confirmLabel="Revoke"
        cancelLabel="Cancel"
        tone="danger"
      />
    </div>
  );
}
