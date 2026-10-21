'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, LoadingSpinner, Pill, Select } from '../components/ui';
import { apiFetch } from '@/lib/apiFetch';
import { pluginsUrl, type AgentPlugin } from '@/lib/agent-plugins';

interface AgentRow {
  container: string;
  label: string;
  running: boolean;
}

type Filter = 'all' | 'enabled' | 'disabled';

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
    <div className={`pl-state${tone === 'error' ? ' pl-state--error' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="pl-state-title">{title}</div>
      {message && <div className="pl-state-message">{message}</div>}
      {action}
    </div>
  );
}

function countLabel(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function PluginRow({ p }: { p: AgentPlugin }) {
  const facts: string[] = [];
  if (p.tools > 0) facts.push(countLabel(p.tools, 'tool'));
  if (p.hooks > 0) facts.push(countLabel(p.hooks, 'hook'));
  if (p.channels.length > 0) facts.push(`channels: ${p.channels.join(', ')}`);
  if (p.providers.length > 0) facts.push(`providers: ${p.providers.join(', ')}`);
  return (
    <li className="pl-row">
      <div className="pl-row-head">
        <span className="pl-row-name">{p.name}</span>
        {p.version && <span className="pl-row-version">v{p.version}</span>}
        <Pill tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'enabled' : 'disabled'}</Pill>
        {p.status && p.status !== 'enabled' && p.status !== 'disabled' && <Pill tone="info">{p.status}</Pill>}
        {p.origin && <Pill tone="accent">{p.origin}</Pill>}
      </div>
      {p.name !== p.id && <div className="pl-row-id">{p.id}</div>}
      {p.description && <div className="pl-row-desc">{p.description}</div>}
      {facts.length > 0 && <div className="pl-row-facts">{facts.join(' · ')}</div>}
    </li>
  );
}

export default function PluginsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsReload, setAgentsReload] = useState(0);
  const [selected, setSelected] = useState('');

  const [plugins, setPlugins] = useState<AgentPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [truncated, setTruncated] = useState(false);
  /** Set by a Reload or Retry click and used by the next request only: an agent switch keeps the server cache. */
  const freshRef = useRef(false);
  const reloadFresh = () => { freshRef.current = true; setReload((n) => n + 1); };

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const pluginsAbortRef = useRef<AbortController | null>(null);

  // The agent list, on mount and on "Check again".
  useEffect(() => {
    const controller = new AbortController();
    setAgentsLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/plugins', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (controller.signal.aborted) return;
          setAgents([]); setAgentsError(message);
          return;
        }
        const data = await res.json() as { agents?: AgentRow[]; dockerAvailable?: boolean };
        if (controller.signal.aborted) return;
        const list = Array.isArray(data.agents) ? data.agents : [];
        setAgents(list);
        setDockerAvailable(data.dockerAvailable !== false);
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

  // The selected agent's plugins: the latest request wins (AGENTS.md 2.2b.10).
  useEffect(() => {
    pluginsAbortRef.current?.abort();
    if (!canLoad) {
      setPlugins([]); setError(null); setLoading(false);
      return;
    }
    const controller = new AbortController();
    pluginsAbortRef.current = controller;
    setLoading(true);
    setError(null);
    setPlugins([]); setTruncated(false);
    const fresh = freshRef.current;
    freshRef.current = false;
    void (async () => {
      try {
        const res = await apiFetch(pluginsUrl(selected, fresh), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (!controller.signal.aborted) setError(message);
          return;
        }
        const data = await res.json() as { plugins?: AgentPlugin[]; truncated?: boolean };
        if (controller.signal.aborted) return;
        setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
        setTruncated(data.truncated === true);
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return;
        setError('Could not load the plugins.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selected, canLoad, reload]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filter === 'enabled' && !p.enabled) return false;
      if (filter === 'disabled' && p.enabled) return false;
      if (!q) return true;
      return p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    });
  }, [plugins, query, filter]);

  const enabledCount = plugins.filter((p) => p.enabled).length;

  let body: React.ReactNode;
  if (agentsLoading) {
    body = <LoadingSpinner label="LOADING" compact />;
  } else if (agentsError) {
    body = <StatePanel tone="error" title="Could not load the agent list" message={agentsError} action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Retry</Button>} />;
  } else if (!dockerAvailable) {
    body = <StatePanel tone="error" title="Docker is not running" message="Start Docker to see the plugins of your agents." action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Check again</Button>} />;
  } else if (agents.length === 0) {
    body = <StatePanel title="No agents yet" message="Create an agent on the Agents page to see its plugins here." />;
  } else if (current && !current.running) {
    body = <StatePanel title="This agent is not running. Start it from the Agents page." action={<Button variant="secondary" size="sm" onClick={() => setAgentsReload((n) => n + 1)}>Check again</Button>} />;
  } else if (loading) {
    body = <LoadingSpinner label="LOADING PLUGINS" compact />;
  } else if (error) {
    body = <StatePanel tone="error" title="Could not load the plugins" message={error} action={<Button variant="secondary" size="sm" onClick={reloadFresh}>Retry</Button>} />;
  } else if (plugins.length === 0) {
    body = <StatePanel title="This agent has no plugins" />;
  } else if (shown.length === 0) {
    body = <StatePanel title="No plugins match" />;
  } else {
    body = <ul className="pl-list">{shown.map((p) => <PluginRow key={p.id} p={p} />)}</ul>;
  }

  const showTools = canLoad && !loading && !error && plugins.length > 0;

  return (
    <div className="pl-page">
      <div className="pl-header">
        <span className="pl-title">PLUGINS</span>
        {!agentsLoading && agents.length > 0 && (
          <Select
            aria-label="Agent"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            options={agents.map((a) => ({ value: a.container, label: a.running ? a.label : `${a.label} (stopped)` }))}
          />
        )}
        {showTools && <span className="pl-count">{enabledCount} of {plugins.length} enabled{truncated ? " (list cut at 2000)" : ""}</span>}
        {canLoad && (
          <Button variant="ghost" size="sm" onClick={reloadFresh} disabled={loading} aria-label="Reload plugins">
            Reload
          </Button>
        )}
      </div>
      {showTools && (
        <div className="pl-toolbar">
          <div className="pl-search">
            <Input
              aria-label="Search plugins"
              placeholder="Search plugins"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="pl-filters">
            {(['all', 'enabled', 'disabled'] as const).map((f) => (
              <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
                {f.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="pl-body">{body}</div>
    </div>
  );
}
