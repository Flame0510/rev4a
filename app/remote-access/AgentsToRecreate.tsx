'use client';

import { Button, ItemList, Pill } from '../components/ui';
import type { RemoteAccessData } from './useRemoteAccess';

export function AgentsToRecreate({ data }: { data: RemoteAccessData }) {
  const { state, visibleRecreateRows, recreate, busy } = data;
  if (!visibleRecreateRows.length && !state?.agents.stoppedDiffering && state?.agents.differing !== null) return null;
  const change = state?.agents.mode === 'local' ? 'Different address → this host' : state?.agents.mode === 'all' ? 'Different address → every interface' : 'Ports differ';
  return <section style={{ display: 'grid', gap: 12 }} aria-labelledby="agents-to-recreate">
    <h2 id="agents-to-recreate" className="ui-kicker">Agents to recreate</h2>
    {!!visibleRecreateRows.length && <ItemList items={visibleRecreateRows.map((agent) => ({
      id: agent.id,
      content: <><span>{agent.name}</span><Pill>{recreate?.agentId === agent.id ? 'Recreate in progress' : change}</Pill></>,
      action: <Button type="button" disabled={!!busy} loading={busy === `recreate:${agent.id}`} onClick={() => data.startRecreate(agent.id)}>
        {busy === `recreate:${agent.id}` ? 'Recreating…' : 'Recreate'}
      </Button>,
    }))} />}
    {recreate && <p role="status" className="ui-text-small">{recreate.job?.status === 'backing_up' ? `Backing up… ${recreate.job.backupPercent ?? 0}%` : 'Recreating container…'}</p>}
    {!!state?.agents.stoppedDiffering && <p className="ui-muted ui-text-small">{state.agents.stoppedDiffering} stopped agents will ask before starting</p>}
    {state?.agents.differing === null && <p className="ui-muted ui-text-small">Could not check agent ports. Docker may be unavailable.</p>}
  </section>;
}
