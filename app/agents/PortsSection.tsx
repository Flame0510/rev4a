'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfirmModal, ItemList, Pill, Surface } from '../components/ui';
import { controlUiTunnelCommand } from '@/lib/control-ui-navigation';
import type { PortBindings } from '@/lib/agent-ports';
import type { AgentPortStatus } from '@/lib/agent-ports-status';
import { OpenControlUiButton, type GatewayState } from './BrowserAccessSection';

export default function PortsSection({ agentId, bindings, running, gateway, blocksOpen, modelMissing = false }: {
  agentId: string;
  /** The agent has no model yet (models-summary `unset`): the Control UI shortcut is replaced by model setup elsewhere in the panel. */
  modelMissing?: boolean;
  bindings: PortBindings;
  running: boolean;
  gateway?: GatewayState;
  blocksOpen?: boolean;
}) {
  const [ports, setPorts] = useState<AgentPortStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'refresh' | null>('refresh');
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bindingsKey = JSON.stringify(Object.entries(bindings ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setConfirmUrl(null);
    setBusyAction('refresh');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/ports`, { signal: controller.signal });
      if (!response.ok) throw new Error('Could not load ports');
      const data: { ports: AgentPortStatus[] } = await response.json();
      if (!controller.signal.aborted) setPorts(data.ports);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError' && !controller.signal.aborted) {
        setPorts(null);
        setError('Could not load ports. Try refreshing.');
      }
    } finally {
      if (!controller.signal.aborted) setBusyAction(null);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh, running, bindingsKey]);

  return (
    <Surface compact>
      <div className="agent-ports-heading">
        <h3>Ports</h3>
        <Button type="button" variant="secondary" size="sm" onClick={refresh} loading={busyAction === 'refresh'} disabled={busyAction !== null}>
          {busyAction === 'refresh' ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {ports?.length === 0 && <p>No TCP ports published in the 3000–3009 range.</p>}
      {!!ports?.length && <ItemList items={ports.map(({ containerPort, hostPort, listening, url, auth }) => {
        const hostIp = bindings?.[`${containerPort}/tcp`]?.find((binding) => Number(binding?.HostPort) === hostPort)?.HostIp;
        const controlUi = containerPort === 3000;
        const publicUrl = url?.startsWith('https://') ? url : undefined;
        // Plain HTTP carries the dashboard cookie to a dev server on the same host.
        const warnBeforeOpening = url?.startsWith('http://') && window.location.protocol === 'http:';
        return {
          id: String(containerPort),
          content: <>
            <strong>{controlUi ? 'Control UI ' : ''}{containerPort} → {hostPort}</strong>
            <Pill tone={listening ? 'success' : 'neutral'}>
              {listening === null ? 'Unknown' : listening ? 'Listening' : 'Not listening'}
            </Pill>
            {running && url && (controlUi ? <code>{url}</code> : warnBeforeOpening ? (
              <Button type="button" variant="secondary" size="sm" disabled={busyAction !== null} onClick={() => setConfirmUrl(url)}>{url}</Button>
            ) : <a className="ui-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>)}
            {running && auth === 'basic' && <span>user rev4a — password on the <a className="ui-link" href="/remote-access">Remote access page</a></span>}
            {running && !url && <code>{controlUiTunnelCommand(String(hostPort), window.location.hostname, hostIp)}</code>}
          </>,
          action: running && controlUi && url && !modelMissing ? (
            <OpenControlUiButton agentId={agentId} hostIp={hostIp} publicUrl={publicUrl} gateway={gateway} blocksOpen={blocksOpen} disabled={busyAction !== null} />
          ) : undefined,
        };
      })} />}
      <ConfirmModal
        open={confirmUrl !== null}
        title="Open this HTTP port?"
        message="Opening this port over plain HTTP also sends your Rev4a session cookie to the dev server. Continue only if you trust the server."
        tone="warning"
        confirmLabel="Open port"
        onClose={() => setConfirmUrl(null)}
        onConfirm={() => {
          if (confirmUrl) window.open(confirmUrl, '_blank', 'noopener,noreferrer');
          setConfirmUrl(null);
        }}
      />
    </Surface>
  );
}
