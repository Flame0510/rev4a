'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { agentPortsLabel, requestAgentLifecycle, type AgentStartChoice } from '@/lib/agent-start';

export interface AgentStartPrompt {
  agentId: string;
  name: string;
  hostIp?: string | null;
  setting: string;
}

/** A port mismatch is never consent to rebuild. Only the two explicit clicks mutate. */
export function AgentStartDialog({ prompt, onClose, onStarted, onComplete }: {
  prompt: AgentStartPrompt;
  onClose: () => void;
  onStarted: () => void;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState<AgentStartChoice | null>(null);
  const busyRef = useRef<AgentStartChoice | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [setting, setSetting] = useState(prompt.setting);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const release = () => { busyRef.current = null; setBusy(null); };
  const close = () => { if (!busyRef.current) onClose(); };
  const poll = async (jobId: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(prompt.agentId)}/recreate`, {
        signal: controller.signal, cache: 'no-store',
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Could not read the recreate job. Retrying…');
      const job = data.recreate;
      if (!job || job.id !== jobId) {
        setError('The recreate job changed or is no longer available. Check the agent before trying again.');
        setProgress(''); release(); return;
      }
      if (job.status === 'done') { release(); onComplete(); return; }
      if (job.status === 'failed' || job.status === 'interrupted') {
        setError(job.error || `Recreate ${job.status}.`); setProgress(''); release(); return;
      }
      setError('');
      setProgress(job.status === 'backing_up' ? `Backing up… ${job.backupPercent ?? 0}%` : 'Recreating container…');
    } catch (e) {
      if (controller.signal.aborted || (e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    }
    // One read at a time, always for the id returned by this operator's click.
    timerRef.current = setTimeout(() => { void poll(jobId); }, 2000);
  };

  const choose = async (ports: AgentStartChoice) => {
    if (busyRef.current) return;
    busyRef.current = ports; setBusy(ports); setError('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await requestAgentLifecycle(prompt.agentId, 'start', controller.signal, ports);
      if (controller.signal.aborted) return;
      if (result.kind === 'ports_differ') { setSetting(result.setting); release(); return; }
      onStarted();
      if (result.kind === 'recreate') { setProgress('Backing up…'); void poll(result.id); return; }
      release(); onComplete();
    } catch (e) {
      if (controller.signal.aborted || (e as Error).name === 'AbortError') return;
      setError((e as Error).message); release();
    }
  };

  return <Modal open title={`Start ${prompt.name}`} onClose={close} maxWidth={560}>
    <p>Its ports still listen on {agentPortsLabel(prompt.hostIp)}; Remote access is set to {setting}.</p>
    <p><a className="ui-link" href="/remote-access">Remote access</a></p>
    {progress && <p role="status">{progress}</p>}
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button type="button" variant="primary" disabled={!!busy} loading={busy === 'move'} onClick={() => { void choose('move'); }}>
        {busy === 'move' ? 'Moving…' : 'Move and start'}
      </Button>
      <Button type="button" variant="secondary" disabled={!!busy} loading={busy === 'as_is'} onClick={() => { void choose('as_is'); }}>
        {busy === 'as_is' ? 'Starting…' : 'Start as is'}
      </Button>
      <Button type="button" variant="ghost" disabled={!!busy} onClick={close}>Cancel</Button>
    </div>
  </Modal>;
}
