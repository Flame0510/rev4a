'use client';

import { useEffect, useRef, useState } from 'react';

interface ListenState {
  panel: { mode: 'all' | 'local' | 'address'; port: number; addresses: string[] };
  agents: { mode: 'all' | 'local' | 'address'; differing?: number | null };
}

const GUIDE_URL = 'https://rev4a.app/en/docs/remote-access';

function panelText(panel: ListenState['panel']): string {
  if (panel.mode === 'all') return 'every network interface';
  const list = panel.addresses.map((a) => (a.includes(':') ? `[${a}]` : a) + `:${panel.port}`).join(', ');
  return `${panel.mode === 'local' ? 'this host only' : 'one address'}${list ? ` (${list})` : ''}`;
}

const agentsText = (mode: ListenState['agents']['mode']) =>
  mode === 'all' ? 'every network interface' : mode === 'local' ? 'this host only' : 'one address';

/** One line on the System page: where the panel and the agents' ports listen. Hidden until it loads. */
export function RemoteAccessLine() {
  const [state, setState] = useState<ListenState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/system/listen', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (body?.panel && body?.agents) setState(body); })
      .catch(() => { /* informational only */ });
    return () => controller.abort();
  }, []);
  if (!state) return null;
  return (
    <p className="ui-muted" style={{ fontSize: 12, margin: 0 }}>
      Remote access: the panel listens on {panelText(state.panel)}; agent ports on {agentsText(state.agents.mode)}.{' '}
      {!!state.agents.differing && (
        <> {state.agents.differing} running {state.agents.differing === 1 ? 'agent is' : 'agents are'} still published on a different address than this setting — Recreate {state.agents.differing === 1 ? 'it' : 'them'} to apply.</>
      )}{' '}
      <a className="ui-link" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Remote access guide ↗</a>
    </p>
  );
}
