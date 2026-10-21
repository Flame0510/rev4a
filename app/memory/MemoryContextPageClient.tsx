'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, LoadingSpinner, Meter, Pill, Select, meterLevel } from '../components/ui';
import { apiFetch } from '@/lib/apiFetch';
import { contextUrl, workspaceFileUrl, type ContextView } from '@/lib/memory-context';
import { useRev4aTimezone } from '@/lib/hooks/useRev4aTimezone';
import { formatDateTimeInTimezone } from '@/lib/timezone';

interface AgentRow {
  container: string;
  label: string;
  running: boolean;
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch { /* not JSON */ }
  return `Request failed (HTTP ${res.status})`;
}

function StatePanel({ title, message, action, tone = 'muted' }: { title: string; message?: string; action?: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div className={`cx-state${tone === 'error' ? ' cx-state--error' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="cx-state-title">{title}</div>
      {message && <div className="cx-state-message">{message}</div>}
      {action}
    </div>
  );
}

function chars(n: number): string {
  return n.toLocaleString('en-US');
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceText(source: 'default' | 'config'): string {
  return source === 'config' ? 'set in the agent config' : 'OpenClaw default';
}

type ContextData = ContextView & { agent: string };

export default function ContextPage() {
  const timezone = useRev4aTimezone();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsReload, setAgentsReload] = useState(0);
  const [selected, setSelected] = useState('');

  const [data, setData] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** Set by a Reload or Retry click and used by the next request only: an agent switch keeps the server cache. */
  const freshRef = useRef(false);
  const reloadFresh = () => { freshRef.current = true; setReload((n) => n + 1); };
  const abortRef = useRef<AbortController | null>(null);

  // The agent list, on mount and on "Check again".
  useEffect(() => {
    const controller = new AbortController();
    setAgentsLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/memory-context', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (controller.signal.aborted) return;
          setAgents([]); setAgentsError(message);
          return;
        }
        const body = await res.json() as { agents?: AgentRow[]; dockerAvailable?: boolean };
        if (controller.signal.aborted) return;
        const list = Array.isArray(body.agents) ? body.agents : [];
        setAgents(list);
        setDockerAvailable(body.dockerAvailable !== false);
        setAgentsError(null);
        setSelected((prev) => (list.some((a) => a.container === prev) ? prev : (list.find((a) => a.running) ?? list[0])?.container ?? ''));
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return;
        setAgents([]); setAgentsError('Could not load the agent list.');
      } finally {
        if (!controller.signal.aborted) setAgentsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [agentsReload]);

  const current = agents.find((a) => a.container === selected) ?? null;
  const canLoad = dockerAvailable && current != null && current.running;

  // The selected agent's context: the latest request wins (AGENTS.md 2.2b.10).
  useEffect(() => {
    abortRef.current?.abort();
    if (!canLoad) {
      setData(null); setError(null); setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setData(null);
    const fresh = freshRef.current;
    freshRef.current = false;
    void (async () => {
      try {
        const res = await apiFetch(contextUrl(selected, fresh), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (!controller.signal.aborted) setError(message);
          return;
        }
        const body = await res.json() as ContextData;
        if (controller.signal.aborted) return;
        setData(body);
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return;
        setError('Could not load the context.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selected, canLoad, reload]);

  let body: React.ReactNode;
  if (agentsLoading) {
    body = <LoadingSpinner label="LOADING" compact />;
  } else if (agentsError) {
    body = <StatePanel tone="error" title="Could not load the agent list" message={agentsError} action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Retry</Button>} />;
  } else if (!dockerAvailable) {
    body = <StatePanel tone="error" title="Docker is not running" message="Start Docker to see the context of your agents." action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Check again</Button>} />;
  } else if (agents.length === 0) {
    body = <StatePanel title="No agents yet" message="Create an agent on the Agents page to see its context here." />;
  } else if (current && !current.running) {
    body = <StatePanel title="This agent is not running. Start it from the Agents page." action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Check again</Button>} />;
  } else if (loading) {
    body = <LoadingSpinner label="LOADING CONTEXT" compact />;
  } else if (error) {
    body = <StatePanel tone="error" title="Could not load the context" message={error} action={<Button variant="secondary" size="sm" onClick={reloadFresh}>Retry</Button>} />;
  } else if (data) {
    const perFile = data.limits.perFile.value;
    const totalPct = data.totals.cap > 0 ? (data.totals.injected / data.totals.cap) * 100 : 0;
    body = (
      <div className="cx-content">
        <section className="cx-summary" aria-label="Summary">
          <div className="cx-summary-main">
            <span className="cx-summary-value">{chars(data.totals.injected)}</span>
            <span className="cx-summary-of"> of {chars(data.totals.cap)} characters injected</span>
          </div>
          <Meter percent={totalPct} level={meterLevel(totalPct, 80, 100)} label="Injected characters against the total cap" />
          <div className="cx-summary-facts">
            {data.totals.truncatedFiles > 0
              ? <Pill tone="warning">{data.totals.truncatedFiles} {data.totals.truncatedFiles === 1 ? 'file' : 'files'} truncated</Pill>
              : <Pill tone="success">No file truncated</Pill>}
            <span>Per file: {chars(perFile)} characters ({sourceText(data.limits.perFile.source)})</span>
            <span>Total: {chars(data.limits.total.value)} characters ({sourceText(data.limits.total.source)})</span>
          </div>
          {data.totals.linkedFiles > 0 && (
            <p className="cx-hint">{data.totals.linkedFiles === 1 ? '1 linked file is' : `${data.totals.linkedFiles} linked files are`} not counted in this total.</p>
          )}
          <p className="cx-hint">OpenClaw puts these files in the agent&apos;s prompt at the start of each session. A file longer than the cap is cut, and the agent never sees the cut part. A sub-agent session gets AGENTS.md only, and blank files are skipped. Click a file to open it in the Workspace page, where you can edit it.</p>
        </section>

        <section className="cx-section" aria-label="Prompt files">
          <h2 className="cx-heading">PROMPT FILES</h2>
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead>
                <tr><th>File</th><th>Size</th><th>Injected</th><th className="cx-col-bar">Share of the per-file cap</th></tr>
              </thead>
              <tbody>
                {data.files.map((f) => {
                  const pct = f.chars !== null && perFile > 0 ? (f.chars / perFile) * 100 : 0;
                  return (
                    <tr key={f.name}>
                      <td>
                        {f.exists
                          ? <Link className="cx-link" href={workspaceFileUrl(selected, f.path)}>{f.name}</Link>
                          : <span className="cx-missing">{f.name}</span>}
                        {f.note && <div className="cx-note">{f.note}</div>}
                        {f.linked && <div className="cx-note">Linked file: OpenClaw follows it, but its size is not read here.</div>}
                      </td>
                      <td className="cx-num">{f.exists ? (f.linked ? 'linked file' : f.chars === null ? '—' : chars(f.chars)) : (f.optional ? 'not present' : 'missing')}</td>
                      <td className="cx-num">{f.linked ? 'unknown' : f.exists && f.chars !== null ? chars(f.injected) : '—'}</td>
                      <td className="cx-col-bar">
                        {f.exists && f.chars !== null && (
                          <div className="cx-bar">
                            <Meter percent={pct} level={f.truncated ? 'critical' : meterLevel(pct, 80, 101)} label={`${f.name} against the per-file cap`} />
                            {f.truncated && <Pill tone="warning">truncated</Pill>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {data.other.length > 0 && (
          <div className="cx-note">
            Other workspace files, not injected into the prompt:{' '}
            {data.other.map((o, i) => (
              <span key={o.name}>{i > 0 && ', '}<Link className="cx-link" href={workspaceFileUrl(selected, o.path)}>{o.name}</Link></span>
            ))}
          </div>
        )}

        <section className="cx-section" aria-label="Rev4a rules">
          <h2 className="cx-heading">REV4A RULES</h2>
          <div className="cx-rules">
            {data.rules.exists
              ? <Link className="cx-link" href={workspaceFileUrl(selected, data.rules.path)}>{data.rules.path}</Link>
              : <span className="cx-missing">{data.rules.path}</span>}
            <span className="cx-meta">{data.rules.linked ? 'linked folder, not read' : data.rules.exists ? `${data.rules.size === null ? '—' : `${chars(data.rules.size)} characters`} · read-only` : 'not found'}</span>
          </div>
        </section>

        <section className="cx-section" aria-label="Memory files">
          <h2 className="cx-heading">MEMORY FILES{data.memory.files.length > 0 ? ` (${data.memory.files.length}${data.memory.truncated ? '+' : ''})` : ''}</h2>
          {data.memory.linked ? (
            <div className="cx-empty">memory/ is a linked folder, not read.</div>
          ) : data.memory.files.length === 0 ? (
            <div className="cx-empty">The agent has not saved any file under memory/ yet.</div>
          ) : (
            <ul className="cx-mem-list">
              {data.memory.files.map((m) => (
                <li key={m.path} className="cx-mem-row">
                  <Link className="cx-link" href={workspaceFileUrl(selected, m.path)}>{m.name}</Link>
                  <span className="cx-meta">{bytes(m.size)} · {formatDateTimeInTimezone(new Date(m.mtimeMs).toISOString(), {}, timezone)}</span>
                </li>
              ))}
            </ul>
          )}
          {data.memory.truncated && <div className="cx-note">Showing the newest {data.memory.files.length} files; the list is cut (too many files, or folders nested deeper than three levels).</div>}
        </section>
      </div>
    );
  } else {
    body = null;
  }

  return (
    <div className="cx-page">
      <div className="cx-header">
        <span className="cx-title">CONTEXT</span>
        {!agentsLoading && agents.length > 0 && (
          <Select
            aria-label="Agent"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            options={agents.map((a) => ({ value: a.container, label: a.running ? a.label : `${a.label} (stopped)` }))}
          />
        )}
        {canLoad && (
          <Button variant="ghost" size="sm" className="cx-reload" onClick={reloadFresh} disabled={loading} aria-label="Reload context">
            Reload
          </Button>
        )}
      </div>
      <div className="cx-body">{body}</div>
    </div>
  );
}
