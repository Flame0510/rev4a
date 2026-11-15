'use client';

/**
 * Shown before "Open" when Rev4a is on plain HTTP on a host that is not loopback: cookies
 * ignore ports, so the agent's port would receive the Rev4a session too. Offers the safe
 * way (an SSH tunnel), then lets the person open anyway. Asked every time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal } from '../components/ui';
import { controlUiTunnelCommand, controlUiTunnelPath } from '@/lib/control-ui-navigation';

const GUIDE_URL = 'https://rev4a.app/en/docs/remote-access';

/** The Clipboard API needs a secure context, which a plain-HTTP page is not: fall back to a hidden selection. */
async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Try the selection below.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(area);
  return ok;
}

export function ControlUiExposureModal({
  open,
  agentId,
  jobId,
  onClose,
  onOpenAnyway,
}: {
  open: boolean;
  agentId: string;
  jobId?: string;
  onClose: () => void;
  onOpenAnyway: () => void;
}) {
  const [port, setPort] = useState<string | null>(null);
  const [portError, setPortError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [busy, setBusy] = useState<'link' | 'command' | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'command' | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const portAbortRef = useRef<AbortController | null>(null);

  const hostname = typeof location === 'undefined' ? '' : location.hostname;

  const fetchTunnel = useCallback(async (ref: { current: AbortController | null }, what: 'link' | 'port'): Promise<{ url: string; port: string }> => {
    ref.current?.abort();
    const controller = new AbortController();
    ref.current = controller;
    const res = await fetch(controlUiTunnelPath(agentId, jobId, what), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || (what === 'link' ? typeof body?.url !== 'string' : body?.port == null)) throw new Error(typeof body?.error === 'string' ? body.error : `Error ${res.status}`);
    return { url: what === 'link' ? body.url : '', port: String(body.port) };
  }, [agentId, jobId]);

  // The command's port comes from the server: one port-only read per opening (no link is issued).
  useEffect(() => {
    if (!open) return;
    setPort(null);
    setPortError('');
    setLinkError('');
    setManual(null);
    setCopied(null);
    fetchTunnel(portAbortRef, 'port')
      .then((answer) => setPort(answer.port))
      .catch((e: { name?: string; message?: string }) => {
        if (e?.name !== 'AbortError') setPortError(e?.message || 'Could not read the agent port');
      });
    return () => { portAbortRef.current?.abort(); abortRef.current?.abort(); };
  }, [open, fetchTunnel]);

  const command = port ? controlUiTunnelCommand(port, hostname) : null;

  const copyCommand = async () => {
    if (!command) return;
    setBusy('command');
    const ok = await copyText(command);
    setBusy(null);
    setCopied(ok ? 'command' : null);
    if (!ok) setManual(command);
  };

  const copyLink = async () => {
    setBusy('link');
    setManual(null);
    setLinkError('');
    try {
      const { url } = await fetchTunnel(abortRef, 'link');
      const ok = await copyText(url);
      setCopied(ok ? 'link' : null);
      if (!ok) setManual(url);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') setLinkError((e as Error).message || 'Could not build the tunnel link');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Open the Control UI" tone="warning" maxWidth={560}>
      <p style={{ fontSize: 12, margin: '0 0 12px' }}>
        Rev4a is on plain HTTP. Opening the agent from here also sends your Rev4a session to the agent&apos;s port: a
        compromised agent could use it to sign in to Rev4a with all your keys.
      </p>

      <div className="ui-kicker">Safe way: an SSH tunnel</div>
      <p className="ui-muted" style={{ fontSize: 12, margin: '6px 0' }}>Run this on your computer:</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input readOnly aria-label="SSH tunnel command" value={command ?? (portError ? '' : '…')} placeholder={portError} />
        </div>
        <Button variant="secondary" size="sm" disabled={!command || busy !== null} loading={busy === 'command'} onClick={() => { void copyCommand(); }}>
          {busy === 'command' ? 'Copying…' : copied === 'command' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {portError && <p style={{ color: 'var(--red)', fontSize: 11, margin: '6px 0' }}>{portError}</p>}
      <p className="ui-muted" style={{ fontSize: 12, margin: '10px 0 6px' }}>Then open the tunnel link on this computer.</p>

      {linkError && <p style={{ color: 'var(--red)', fontSize: 11, margin: '6px 0' }}>{linkError}</p>}
      {manual && (
        <div style={{ margin: '6px 0' }}>
          <Input readOnly aria-label="Text to copy by hand" value={manual} onFocus={(e) => e.currentTarget.select()} />
          <p className="ui-muted" style={{ fontSize: 11, margin: '4px 0 0' }}>The browser blocked copying: select the text and press Ctrl+C or ⌘C.</p>
        </div>
      )}

      <div className="ui-kicker" style={{ marginTop: 12 }}>For good: serve Rev4a over HTTPS</div>
      <p className="ui-muted" style={{ fontSize: 12, margin: '6px 0' }}>
        <a className="ui-link" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Remote access guide ↗</a>
      </p>
      <p className="ui-muted" style={{ fontSize: 11, margin: '10px 0 0' }}>
        Any page that opens this agent&apos;s port on this address sends the session too, not only this button.
      </p>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onClose}>Cancel</Button>
        <Button variant="secondary" size="sm" loading={busy === 'link'} disabled={busy !== null} onClick={() => { void copyLink(); }}>
          {busy === 'link' ? 'Copying…' : copied === 'link' ? 'Copied' : 'Copy tunnel link'}
        </Button>
        <Button variant="danger" size="sm" disabled={busy !== null} onClick={onOpenAnyway}>Open anyway</Button>
      </div>
    </Modal>
  );
}
