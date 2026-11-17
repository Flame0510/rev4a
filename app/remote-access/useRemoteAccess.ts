'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { currentAccessMode, accessRestartPending, presetEdits, presetGuard, PRESETS, type AccessPreset, type AccessSettings } from '@/lib/remote-access';

export interface ListenState {
  startedAtMs: number | null;
  panel: { mode: string; port: number; addresses: string[] };
  agents: { mode: string; differing: number | null; stoppedDiffering: number | null; runningDiffering: { id: string; name: string }[] };
}
interface RecreateJob { id: number; status: string; error?: string | null; backupPercent?: number | null }

async function jsonResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (HTTP ${response.status})`);
  return body;
}

export function useRemoteAccess() {
  const [state, setState] = useState<ListenState | null>(null);
  const [settings, setSettings] = useState<AccessSettings>({});
  const [startupSettings, setStartupSettings] = useState<AccessSettings>({});
  const [location, setLocation] = useState<{ protocol: string; hostname: string; port: string } | null>(null);
  const [selection, setSelection] = useState<{ preset: AccessPreset; edits: Record<string, string> } | null>(null);
  const [proxyConfirmed, setProxyConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [readError, setReadError] = useState('');
  const [actionError, setError] = useState('');
  const [restartError, setRestartError] = useState('');
  const [message, setMessage] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restartFrom, setRestartFrom] = useState<number | null>(null);
  const [recreate, setRecreate] = useState<{ agentId: string; name: string; jobId: number; job?: RecreateJob } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const jobAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [listen, config] = await Promise.all([
        fetch('/api/system/listen', { cache: 'no-store', signal: controller.signal }).then(jsonResponse),
        fetch('/api/system/remote-access', { cache: 'no-store', signal: controller.signal }).then(jsonResponse),
      ]);
      if (!controller.signal.aborted) { setState(listen); setSettings(config.settings); setStartupSettings(config.startupSettings); setReadError(''); }
    } catch (e) { if (!controller.signal.aborted) setReadError((e as Error).message); }
  }, []);

  useEffect(() => {
    setLocation({ protocol: window.location.protocol, hostname: window.location.hostname, port: window.location.port });
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); abortRef.current?.abort(); actionAbortRef.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (!recreate) return;
    const { agentId, jobId, name } = recreate;
    let timer: ReturnType<typeof setTimeout>;
    jobAbortRef.current?.abort();
    const controller = new AbortController();
    jobAbortRef.current = controller;
    const poll = async () => {
      try {
        const body = await fetch(`/api/agents/${encodeURIComponent(agentId)}/recreate`, { cache: 'no-store', signal: controller.signal }).then(jsonResponse);
        if (controller.signal.aborted) return;
        const job: RecreateJob | null = body.recreate;
        if (!job || job.id !== jobId) throw new Error('Could not find this recreate job. Check the agent panel.');
        if (['done', 'failed', 'interrupted'].includes(job.status)) {
          setMessage(job.status === 'done' ? 'Agent recreated.' : '');
          if (job.error || job.status !== 'done') setError(job.error || 'Recreate was interrupted. Check the agent panel.');
          setRecreate(null); setBusy(null); busyRef.current = false; void refresh();
          return;
        }
        setRecreate({ agentId, name, jobId, job });
        timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(`${(e as Error).message} The job may still be running; check the agent panel.`);
          setRecreate(null); setBusy(null); busyRef.current = false;
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
    // A job update must not restart its polling loop.
  }, [recreate?.agentId, recreate?.jobId, refresh]);

  useEffect(() => {
    if (restartFrom === null) return;
    if (state?.startedAtMs && state.startedAtMs !== restartFrom) {
      setRestartFrom(null);
      if (busy === 'restart') { setBusy(null); busyRef.current = false; }
      setRestartNeeded(false); setRestartError('');
      setMessage('Rev4a restarted. Recreate running agents individually to apply their port setting.');
      return;
    }
    if (restartNeeded) return;
    const timer = setTimeout(() => {
      // Retain the previous boot identity so a late successful read can still confirm recovery.
      setRestartNeeded(true); setBusy(null); busyRef.current = false;
      setRestartError('The restart has not been confirmed. Reconnect at your tested HTTPS address, or check Rev4a and retry.');
    }, 60000);
    return () => clearTimeout(timer);
  }, [restartFrom, state?.startedAtMs, restartNeeded, busy]);

  const choose = (preset: AccessPreset) => {
    if (!location || busyRef.current || !presetGuard(preset, location).allowed) return;
    setProxyConfirmed(false); setError(''); setSelection({ preset, edits: presetEdits(preset, settings) });
  };
  const act = async (key: string, operation: (signal: AbortSignal) => Promise<boolean | void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(key); setError(''); setMessage('');
    actionAbortRef.current?.abort();
    const controller = new AbortController(); actionAbortRef.current = controller;
    let keepBusy = false;
    try { keepBusy = await operation(controller.signal) === true; }
    catch (e) { if (!controller.signal.aborted) { setError((e as Error).message); void refresh(); } }
    finally { if (!keepBusy) { busyRef.current = false; if (!controller.signal.aborted) setBusy(null); } }
  };
  const apply = () => {
    if (!selection || !location || !Object.entries(selection.edits).some(([key, value]) => settings[key as keyof AccessSettings] !== value)) return;
    void act('apply', async (signal) => {
      await fetch('/api/system/remote-access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ ...selection, location, proxyConfirmed }) }).then(jsonResponse);
      setSelection(null); setRestartNeeded(true); setMessage('Access settings saved. Restart Rev4a to apply the panel and trusted proxy settings.'); void refresh();
    });
  };
  const restart = () => void act('restart', async (signal) => {
    setRestartError('');
    await fetch('/api/config/restart', { method: 'POST', signal }).then(jsonResponse);
    setRestartNeeded(false);
    if (state?.startedAtMs) setRestartFrom(state.startedAtMs);
    setMessage('Restart requested. Reconnect at your tested HTTPS address if this address stops answering. Running agents below can be recreated after Rev4a returns.');
    return !!state?.startedAtMs;
  });
  const startRecreate = (agentId: string) => void act(`recreate:${agentId}`, async (signal) => {
    // Recheck immediately before POST: never offer a stopped agent a recreate from stale state.
    const latest: ListenState = await fetch('/api/system/listen', { cache: 'no-store', signal }).then(jsonResponse);
    setState(latest);
    const agent = latest.agents.runningDiffering.find((agent) => agent.id === agentId);
    if (!agent) throw new Error('This agent is no longer running with different ports. Refresh the list.');
    const body = await fetch(`/api/agents/${encodeURIComponent(agentId)}/recreate`, { method: 'POST', signal }).then(jsonResponse);
    setRecreate({ agentId, name: agent.name, jobId: body.id }); return true;
  });

  const mode = state ? currentAccessMode(state.panel.mode, state.agents.mode, { ...settings, REV4A_TRUSTED_PROXIES: startupSettings.REV4A_TRUSTED_PROXIES }) : 'custom';
  const label = PRESETS.find((preset) => preset.id === mode)?.title || (mode === 'default' ? 'Default (as before)' : 'Custom');
  const pending = !!state && accessRestartPending(state.panel, settings, startupSettings);
  const runningDiffering = state?.agents.runningDiffering || [];
  const recreateRows = recreate && !runningDiffering.some((agent) => agent.id === recreate.agentId)
    ? [...runningDiffering, { id: recreate.agentId, name: recreate.name }] : runningDiffering;
  const guard = selection && location ? presetGuard(selection.preset, location) : null;
  const close = () => { if (!busyRef.current) setSelection(null); };
  const hasChanges = !!selection && Object.entries(selection.edits).some(([key, value]) => settings[key as keyof AccessSettings] !== value);
  const visibleRecreateRows = recreateRows.filter((agent) => recreate?.agentId === agent.id || (!pending && !restartNeeded && restartFrom === null));
  const error = actionError || restartError || readError;
  return { state, settings, startupSettings, location, selection, proxyConfirmed, setProxyConfirmed, busy, error, readError, message,
    restartNeeded, restartFrom, recreate, mode, label, pending, guard, hasChanges, visibleRecreateRows, choose, close, apply, restart, startRecreate };
}

export type RemoteAccessData = ReturnType<typeof useRemoteAccess>;
