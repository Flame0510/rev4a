'use client';

/**
 * System packages section of the agent detail panel: what the agent installed with apt and
 * whether the last restore after a start put it all back (GET /api/agents/[id]/packages).
 * Read-only. Everything shown comes from files inside the container, so it is rendered as
 * plain text only.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { splitFailed, type PackageEntry, type PackagesState, type PackagesStatus } from '@/lib/agent-packages';
import { Pill } from '../components/ui';
import type { Tone } from '../components/ui/tokens';
import { PanelRow } from './PanelRow';

interface Packages {
  supported: boolean;
  running: boolean;
  transient?: 'paused' | 'restarting';
  error?: string;
  status: PackagesStatus | null;
  packages: PackageEntry[];
}

const POLL_RUNNING_MS = 10_000;
const POLL_IDLE_MS = 60_000;
/** The list shows this many rows; the rest is counted. */
const LIST_ROWS = 50;
/** A restore is bounded at 15 minutes: a `running` status older than this was cut off. */
const STALE_RUNNING_MS = 20 * 60 * 1000;
const wrap = { overflowWrap: 'anywhere' as const };

const STATE_TONE: Record<PackagesState, Tone> = { ok: 'success', 'nothing-to-do': 'neutral', running: 'info', partial: 'danger', failed: 'danger' };
const STATE_LABEL: Record<PackagesState, string> = { ok: 'Restored', 'nothing-to-do': 'Nothing to restore', running: 'Restoring…', partial: 'Partly restored', failed: 'Failed' };

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const note = (text: string) => <div style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>{text}</div>;
const line = (text: string, color: string) => (
  <div style={{ padding: '8px 14px', fontSize: 11, color, borderBottom: '1px solid var(--border)', wordBreak: 'break-word', ...wrap }}>{text}</div>
);

export default function PackagesSection({ agentId }: { agentId: string }) {
  const [data, setData] = useState<Packages | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const live = data?.status?.state === 'running' && Date.now() - data.status.at <= STALE_RUNNING_MS;
  const polling = live ? POLL_RUNNING_MS : POLL_IDLE_MS;

  useEffect(() => {
    setData(null);
    setError('');
  }, [agentId]);

  useEffect(() => {
    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/packages`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
        setData(body as Packages);
        setError('');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Could not load the system packages');
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, polling);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [agentId, polling]);

  if (error && !data) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--red)' }}>{error}</div>;
  if (!data) return note('Loading…');
  if (!data.supported) return note("This agent's image does not record system packages. Update the agent to get it.");
  if (!data.running) return note('Start the agent to see its system packages.');
  if (data.transient) return note(`The agent is ${data.transient}: its system packages cannot be read now.`);
  if (data.error) return note(data.error);

  const { status, packages } = data;
  if (packages.length === 0 && !status) {
    return note('Nothing installed with apt yet. Packages installed with apt-get or apt are kept across recreates and updates.');
  }
  const now = Date.now();
  const stale = status?.state === 'running' && now - status.at > STALE_RUNNING_MS;
  const { packages: failedPackages, runError } = status ? splitFailed(status) : { packages: [], runError: null };

  return (
    <div>
      {error && line(`Could not refresh (${error}): showing the last answer.`, 'var(--yellow)')}
      {status && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ color: '#888' }}>Last restore</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!stale && <Pill tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Pill>}
              <span style={{ color: '#888' }}>{relativeTime(status.at, now)}</span>
            </span>
          </div>
          {stale && line(`The last restore did not finish (no update since ${relativeTime(status.at, now)}).`, 'var(--yellow)')}
          {runError !== null && line(`The restore did not finish${runError ? `: ${runError}` : ''}`, 'var(--red)')}
          {(status.state === 'failed' || status.state === 'partial') && failedPackages.length === 0 && runError === null && line('The last restore did not complete.', 'var(--red)')}
          {status.restored.length > 0 && <PanelRow label="Reinstalled" value={status.restored.join(', ')} />}
          {status.versionChanged.length > 0 && (
            line(`Installed at another version: ${status.versionChanged.join(', ')}`, 'var(--yellow)')
          )}
          {failedPackages.map((f, i) => (
            <div key={`${i}-${f.name}`} style={{ padding: '8px 14px', fontSize: 11, color: 'var(--red)', borderBottom: '1px solid var(--border)', wordBreak: 'break-word', ...wrap }}>
              Could not reinstall {f.name}{f.error ? `: ${f.error}` : ''}
            </div>
          ))}
        </>
      )}
      {packages.length === 0
        ? note('Nothing installed with apt yet. Packages installed with apt-get or apt are kept across recreates and updates.')
        : packages.slice(0, LIST_ROWS).map((p, i) => (
          <div key={`${i}-${p.name}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ color: '#888', ...wrap }}>{p.name}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%', ...wrap }}>{p.version}</span>
          </div>
        ))}
      {packages.length > LIST_ROWS && note(`and ${packages.length - LIST_ROWS} more`)}
    </div>
  );
}
