'use client';

/**
 * Credentials section of the agent detail panel, read-only: what the Credentials page has
 * switched on for this agent (GET /api/credentials/assignments?agent=, a database read).
 * Switching happens on the Credentials page.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { PanelRow } from './PanelRow';

interface Item {
  profileId: string;
  providerId: string;
  label: string;
  enabled: boolean;
  pendingRemoval: boolean;
  lastError: string | null;
}

export default function CredentialsSection({ agentName }: { agentName: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setItems(null);
    setError('');
    (async () => {
      try {
        const res = await apiFetch(`/api/credentials/assignments?agent=${encodeURIComponent(agentName)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { assignments?: Item[] };
        setItems((json.assignments ?? []).filter((a) => a.enabled || a.pendingRemoval));
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setError((e as Error).message);
      }
    })();
    return () => controller.abort();
  }, [agentName]);

  const note = (text: string) => <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>{text}</div>;

  return (
    <>
      {error && note(`Could not load credentials: ${error}`)}
      {!error && items === null && note('Loading…')}
      {items !== null && items.length === 0 && note('No credentials are switched on for this agent.')}
      {items?.map((a) => (
        <PanelRow
          key={a.profileId}
          label={a.label}
          value={a.pendingRemoval
            ? `Removal failed — retry on the Credentials page. ${a.lastError ?? ''}`.trim()
            : a.lastError ? `Error: ${a.lastError}` : 'Switched on'}
        />
      ))}
      <div style={{ padding: '8px 14px' }}>
        <a href="/credentials" style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'none' }}>Manage credentials →</a>
      </div>
    </>
  );
}
