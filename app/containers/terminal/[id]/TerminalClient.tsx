'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import '@xterm/xterm/css/xterm.css';
import { Badge, Button, type Tone } from '../../../components/ui';

/** Retry delays after a drop; the last one repeats. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
/**
 * Handshakes that fail before ever opening before giving up — about 40 s with the delays
 * above, longer than a Rev4a restart (`rev4a update`).
 */
const MAX_FAILED_OPENS = 6;
/**
 * Close codes from terminal-ws-server.js (and 1000, the page's own deliberate close) after
 * which retrying cannot help: the reason is shown and the page waits for Reconnect, which
 * starts a new shell.
 */
const FINAL_CLOSE_CODES = new Set([1000, 4001, 4002, 4003, 4404, 4409, 4410, 4429, 4500]);

type Status = 'connecting' | 'connected' | 'reconnecting' | 'closed';
const STATUS: Record<Status, { label: string; tone: Tone }> = {
  connecting: { label: 'Connecting…', tone: 'info' },
  connected: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting…', tone: 'warning' },
  closed: { label: 'Closed', tone: 'danger' },
};

/**
 * A random UUID v4. `crypto.randomUUID()` exists only in a secure context (HTTPS or
 * localhost) and a plain-HTTP dashboard (a VPS by IP) is not one; `getRandomValues` is
 * available everywhere.
 */
function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The session id for this container in this tab: a reload resumes the same shell. */
function sessionKey(containerId: string) {
  return `rev4a-terminal-session:${containerId}`;
}
function readSession(containerId: string): string {
  try {
    const stored = sessionStorage.getItem(sessionKey(containerId));
    if (stored) return stored;
    const fresh = uuid();
    sessionStorage.setItem(sessionKey(containerId), fresh);
    return fresh;
  } catch {
    return uuid();
  }
}
function forgetSession(containerId: string) {
  try { sessionStorage.removeItem(sessionKey(containerId)); } catch { /* storage blocked */ }
}

/** The terminal palette from the design tokens, so it follows globals.css. */
function themeFromTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--bg', '#0A0A0B'),
    foreground: v('--text', '#E8E8E8'),
    cursor: v('--violet', '#925BFC'),
    cursorAccent: v('--bg', '#0A0A0B'),
    selectionBackground: 'rgba(146, 91, 252, 0.35)',
  };
}

/**
 * The container terminal: xterm.js (a full terminal emulator — raw keystrokes, cursor
 * movement, full-screen programs) over the WebSocket that server.js forwards to
 * terminal-ws-server.js. The shell survives a dropped connection for two minutes and a
 * reconnect with the same session id picks it up; see docs/CONTAINER-TERMINAL.md.
 */
export default function TerminalClient({ containerId, displayName = null }: { containerId: string; displayName?: string | null }) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  /** Why the terminal stopped retrying; null while it connects or retries. */
  const [stopped, setStopped] = useState<string | null>(null);
  /** Bumped by Reconnect: a new shell. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let cleanupTerminal = () => {};
    setStopped(null);
    setStatus('connecting');

    (async () => {
      // xterm.js touches `window` at import: load it in the browser only.
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        macOptionIsMeta: true,
        theme: themeFromTokens(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(host);
      fit.fit();
      term.focus();

      const note = (text: string) => term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
      const sendSize = () => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      const send = (data: string) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      };
      const inputSub = term.onData(send);
      // Legacy (X10) mouse reports come as binary strings; the PTY takes them as text.
      const binarySub = term.onBinary(send);
      const resizeSub = term.onResize(() => sendSize());
      observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { try { fit.fit(); } catch { /* hidden */ } }, 100);
      });
      observer.observe(host);

      const session = readSession(containerId);
      let drops = 0;
      let failedOpens = 0;
      /** A shell was attached on this page load: later reconnects resume it. */
      let hadShell = false;

      const connect = () => {
        if (disposed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // After a drop the page asks to *resume*: if the shell is gone the server says so
        // (4002) instead of silently starting a new one under the same id.
        const resume = drops > 0 && hadShell ? '&resume=1' : '';
        const ws = new WebSocket(
          `${protocol}//${window.location.host}/api/terminal-ws?id=${encodeURIComponent(containerId)}&session=${session}${resume}`,
        );
        let opened = false;
        wsRef.current = ws;
        ws.onopen = () => {
          if (disposed) { ws.close(1000); return; }
          opened = true;
          hadShell = true;
          if (drops) note('reconnected');
          drops = 0;
          failedOpens = 0;
          setStatus('connected');
          sendSize();
          term.focus();
        };
        ws.onmessage = (event) => {
          if (typeof event.data === 'string') term.write(event.data); // the server sends text only
        };
        ws.onclose = (event) => {
          if (disposed || wsRef.current !== ws) return;
          if (FINAL_CLOSE_CODES.has(event.code)) {
            forgetSession(containerId);
            setStatus('closed');
            setStopped(event.reason || 'The terminal session ended.');
            if (opened) note(event.reason || 'session ended');
            return;
          }
          if (!opened && ++failedOpens >= MAX_FAILED_OPENS) {
            setStatus('closed');
            setStopped('Cannot open the terminal. Check that you are still logged in and that Rev4a is running; behind a reverse proxy, that it forwards WebSocket upgrades and keeps the Host header.');
            return;
          }
          if (opened) note('connection lost — reconnecting');
          const delay = RECONNECT_DELAYS_MS[Math.min(drops, RECONNECT_DELAYS_MS.length - 1)];
          drops++;
          setStatus('reconnecting');
          reconnectTimer = setTimeout(connect, delay);
        };
      };
      connect();

      cleanupTerminal = () => {
        inputSub.dispose();
        binarySub.dispose();
        resizeSub.dispose();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      const ws = wsRef.current;
      wsRef.current = null;
      // Leaving the page is not a deliberate close: the shell waits two minutes for a reload.
      ws?.close(4000, 'page left');
      cleanupTerminal();
    };
  }, [containerId, generation]);

  function handleClose() {
    // A deliberate close ends the shell at once (code 1000) instead of keeping it for a return.
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000, 'closed');
    } else {
      // Not connected right now (reconnecting): attach briefly to the waiting shell only to end
      // it, so it does not linger for two minutes.
      ws?.close(4000, 'page left');
      const session = readSession(containerId);
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ender = new WebSocket(
        `${protocol}//${window.location.host}/api/terminal-ws?id=${encodeURIComponent(containerId)}&session=${session}&resume=1`,
      );
      ender.onopen = () => ender.close(1000, 'closed');
    }
    forgetSession(containerId);
    router.push('/containers');
  }

  function handleReconnect() {
    forgetSession(containerId);
    setGeneration((g) => g + 1);
  }

  const s = STATUS[status];
  return (
    <div className="terminal-page">
      <div className="terminal-page__bar">
        <div className="terminal-page__title">
          <span className="ui-kicker ui-kicker--accent">Terminal</span>
          <span className="terminal-page__container" title={displayName ? containerId : undefined}>{displayName || containerId}</span>
          {displayName && displayName !== containerId && <span className="ui-muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono-stack)' }}>{containerId}</span>}
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <div className="terminal-page__actions">
          {stopped && (
            <Button type="button" variant="secondary" size="sm" onClick={handleReconnect}>Reconnect</Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Close</Button>
        </div>
      </div>
      {stopped && <div role="status" className="terminal-page__notice">{stopped}</div>}
      <div ref={hostRef} className="terminal-page__screen" />
    </div>
  );
}
