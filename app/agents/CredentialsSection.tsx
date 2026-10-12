'use client';

/**
 * Credentials section of the agent detail panel, read-only: what the Credentials page has
 * switched on for this agent (GET /api/credentials/assignments?agent=, a database read) and
 * the credentials an earlier release installed the old way (GET /api/credentials/detect,
 * which probes the container and takes seconds, so it fills in after the first). Switching
 * happens on the Credentials page.
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

interface OldWay { profileId: string; providerId: string; label: string }

export default function CredentialsSection({ agentName }: { agentName: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [oldWay, setOldWay] = useState<OldWay[]>([]);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setItems(null);
    setOldWay([]);
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
    (async () => {
      try {
        const res = await apiFetch(`/api/credentials/detect?agent=${encodeURIComponent(agentName)}`, { signal: controller.signal });
        if (!res.ok) return;
        const json = await res.json() as { agents?: { matchedProfiles?: OldWay[] }[] };
        setOldWay(json.agents?.[0]?.matchedProfiles ?? []);
      } catch { /* the old-way list is a nicety; the native rows stand without it */ }
    })();
    return () => controller.abort();
  }, [agentName]);

  const note = (text: string) => <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>{text}</div>;
  // A profile already on natively is not also listed as old-way.
  const oldOnly = oldWay.filter((o) => !items?.some((a) => a.profileId === o.profileId && a.enabled));

  return (
    <>
      {error && note(`Could not load credentials: ${error}`)}
      {!error && items === null && note('Loading…')}
      {items !== null && items.length === 0 && oldOnly.length === 0 && note('No credentials are switched on for this agent.')}
      {items?.map((a) => (
        <PanelRow
          key={a.profileId}
          label={a.label}
          value={a.pendingRemoval
            ? `Removal failed — retry on the Credentials page. ${a.lastError ?? ''}`.trim()
            : a.lastError ? `Error: ${a.lastError}` : 'Environment variable'}
        />
      ))}
      {oldOnly.map((o) => (
        <PanelRow key={`old:${o.profileId}`} label={o.label} value="Delivered the old way — use Move to native on the Credentials page" />
      ))}
      <div style={{ padding: '8px 14px' }}>
        <a href="/credentials" style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'none' }}>Manage credentials →</a>
      </div>
    </>
  );
}
