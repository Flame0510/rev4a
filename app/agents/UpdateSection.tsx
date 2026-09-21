'use client';

/**
 * The OpenClaw version of one agent, the Update action and its Rollback, in the
 * agent's detail panel.
 *
 * An update stops the agent, takes a cold backup, recreates it on the newer version
 * (which migrates its data one way), then checks that no transcript events or cron jobs
 * went missing. A rollback restores that backup on the previous version. Data comes from
 * `/api/agents/[id]/update`, polled every 2 s while either runs. See lib/agent-update.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmModal } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';

type UpdateStatus =
  | 'pending' | 'backing_up' | 'migrating' | 'verifying' | 'done'
  | 'failed' | 'interrupted' | 'rolling_back' | 'rolled_back' | 'rollback_failed';

interface Verification {
  sessions: number;
  lostEvents: { session: string; before: number; after: number }[];
  missingCronJobs: string[] | null;
  ok: boolean;
}

interface UpdateView {
  id: number;
  status: UpdateStatus;
  fromVersion: string | null;
  toVersion: string;
  backupFile: string | null;
  backupPercent: number | null;
  verification: Verification | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

interface UpdateInfo {
  currentVersion: string | null;
  candidate: { fromVersion: string; toVersion: string } | null;
  update: UpdateView | null;
}

type Action = 'update' | 'rollback';

const ACTIVE: UpdateStatus[] = ['pending', 'backing_up', 'migrating', 'verifying', 'rolling_back'];
const ROLLBACK_FROM: UpdateStatus[] = ['done', 'failed', 'interrupted', 'rollback_failed'];
const POLL_MS = 2_000;

const STEPS: { status: UpdateStatus; label: string }[] = [
  { status: 'backing_up', label: 'Cold backup' },
  { status: 'migrating', label: 'Start on the new version' },
  { status: 'verifying', label: 'Check transcripts and cron jobs' },
];

const metaStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-word' };

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '';
}

export default function UpdateSection({
  agentId,
  running,
  onChanged,
  onStarted,
}: {
  agentId: string;
  running: boolean;
  /** An update or rollback finished: the parent reloads the agent (new image, new version). */
  onChanged?: () => void;
  /** The update or rollback started — show the UPDATING chip at once. */
  onStarted?: () => void;
}) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastStatus = useRef<UpdateStatus | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/update`, { signal: controller.signal, cache: 'no-store' });
      if (abortRef.current !== controller) return;
      const data = (await res.json().catch(() => null)) as (UpdateInfo & { error?: string }) | null;
      if (abortRef.current !== controller) return;
      if (!res.ok || !data) {
        setLoadError(data?.error ?? `Could not load the update state (HTTP ${res.status})`);
        return;
      }
      setInfo(data);
      setLoadError(null);
      const status = data.update?.status ?? null;
      if (lastStatus.current && ACTIVE.includes(lastStatus.current) && status && !ACTIVE.includes(status)) onChanged?.();
      lastStatus.current = status;
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError' && abortRef.current === controller) setLoadError('Could not load the update state');
    }
  }, [agentId, onChanged]);

  const update = info?.update ?? null;
  const active = !!update && ACTIVE.includes(update.status);

  useEffect(() => {
    setInfo(null);
    setLoadError(null);
    lastStatus.current = null;
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const run = async (action: Action) => {
    setConfirming(null);
    if (busyRef.current) return;
    busyRef.current = action;
    setBusy(action);
    setActionError(null);
    try {
      const res = action === 'update'
        ? await fetch(`/api/agents/${encodeURIComponent(agentId)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: info?.candidate?.toVersion }),
        })
        : await fetch(`/api/agents/${encodeURIComponent(agentId)}/update/rollback`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(data?.error ?? `Could not start the ${action} (HTTP ${res.status})`);
      } else {
        onStarted?.();
      }
    } catch {
      setActionError(`Could not start the ${action}`);
    }
    busyRef.current = null;
    setBusy(null);
    void load();
  };

  if (!info && !loadError) return <SkeletonLines count={2} />;

  const candidate = info?.candidate ?? null;
  const stepIndex = update ? STEPS.findIndex((s) => s.status === update.status) : -1;
  const canRollBack = !!update && !active && ROLLBACK_FROM.includes(update.status) && !!update.backupFile && !!update.fromVersion;

  return (
    <div>
      {loadError && (
        <div style={{ margin: '0 0 6px' }}>
          <Badge tone="danger"><span style={{ fontSize: 10 }}>{loadError}</span></Badge>
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 6 }}>
        OpenClaw {info?.currentVersion ?? 'version unknown'}
      </div>

      {update && active && update.status !== 'rolling_back' && (
        <div style={{ margin: '6px 0 10px' }}>
          <div style={metaStyle}>Updating OpenClaw {update.fromVersion} → {update.toVersion}. The agent is offline until it finishes.</div>
          {STEPS.map((step, i) => {
            const state = update.status === 'pending' ? 'waiting' : i < stepIndex ? 'done' : i === stepIndex ? 'running' : 'waiting';
            return (
              <div key={step.status} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 11 }}>
                <span style={{ width: 14, color: state === 'done' ? 'var(--green)' : state === 'running' ? 'var(--violet)' : 'var(--text-dim)' }}>
                  {state === 'done' ? '✓' : state === 'running' ? '●' : '○'}
                </span>
                <span style={{ color: state === 'waiting' ? 'var(--text-dim)' : 'var(--text)' }}>
                  {step.label}
                  {state === 'running' && step.status === 'backing_up' && update.backupPercent !== null ? ` — ${update.backupPercent}%` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {update && update.status === 'rolling_back' && (
        <div style={{ margin: '6px 0 10px', ...metaStyle }}>
          Rolling back to OpenClaw {update.fromVersion}: restoring {update.backupFile}. The agent is offline until it finishes.
        </div>
      )}

      {update && update.status === 'done' && (
        <div style={{ margin: '6px 0 10px' }}>
          <Badge tone="success"><span style={{ fontSize: 10 }}>Updated from OpenClaw {update.fromVersion} to {update.toVersion}</span></Badge>
          <div style={metaStyle}>
            {when(update.finishedAtMs)}
            {update.verification ? ` · ${update.verification.sessions} session(s) checked` : ''}
            {update.backupFile ? ` · pre-update backup ${update.backupFile}` : ''}
          </div>
        </div>
      )}

      {update && (update.status === 'failed' || update.status === 'interrupted') && (
        <div style={{ margin: '6px 0 10px' }}>
          <Badge tone="danger">
            <span style={{ fontSize: 10 }}>
              Update to OpenClaw {update.toVersion} {update.status === 'interrupted' ? 'was interrupted' : 'failed'}
            </span>
          </Badge>
          {update.error && <div style={metaStyle}>{update.error}</div>}
          {update.verification && update.verification.lostEvents.length > 0 && (
            <div style={metaStyle}>
              {update.verification.lostEvents.map((l) => `${l.session}: ${l.before} → ${l.after}`).join(' · ')}
            </div>
          )}
          {update.backupFile && <div style={metaStyle}>Pre-update backup: {update.backupFile}</div>}
        </div>
      )}

      {update && update.status === 'rolled_back' && (
        <div style={{ margin: '6px 0 10px' }}>
          <Badge tone="warning"><span style={{ fontSize: 10 }}>Rolled back to OpenClaw {update.fromVersion}</span></Badge>
          <div style={metaStyle}>{when(update.finishedAtMs)} · restored {update.backupFile}</div>
        </div>
      )}

      {update && update.status === 'rollback_failed' && (
        <div style={{ margin: '6px 0 10px' }}>
          <Badge tone="danger"><span style={{ fontSize: 10 }}>Rollback to OpenClaw {update.fromVersion} failed</span></Badge>
          {update.error && <div style={metaStyle}>{update.error}</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {candidate && !active && (
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'update'}
            disabled={busy !== null || !running}
            title={running ? undefined : 'Start the agent first: its data is counted while it runs'}
            onClick={() => setConfirming('update')}
          >
            {busy === 'update' ? 'Starting…' : `Update to ${candidate.toVersion}`}
          </Button>
        )}
        {canRollBack && update && (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'rollback'}
            disabled={busy !== null}
            onClick={() => setConfirming('rollback')}
          >
            {busy === 'rollback' ? 'Starting…' : `Roll back to ${update.fromVersion}`}
          </Button>
        )}
      </div>

      {actionError && (
        <div style={{ margin: '6px 0' }}>
          <Badge tone="danger"><span style={{ fontSize: 10 }}>{actionError}</span></Badge>
        </div>
      )}

      <ConfirmModal
        open={confirming === 'update'}
        onClose={() => setConfirming(null)}
        onConfirm={() => { void run('update'); }}
        title={candidate ? `Update to OpenClaw ${candidate.toVersion}?` : 'Update?'}
        message={
          'The agent goes offline, its volume is backed up while stopped, and it starts again on the new version, ' +
          'which migrates its data. The migration cannot be undone in place: going back restores this backup, ' +
          'and anything the agent does after the update is lost.'
        }
        confirmLabel="Update"
        cancelLabel="Cancel"
      />
      <ConfirmModal
        open={confirming === 'rollback'}
        onClose={() => setConfirming(null)}
        onConfirm={() => { void run('rollback'); }}
        title={update?.fromVersion ? `Roll back to OpenClaw ${update.fromVersion}?` : 'Roll back?'}
        message={
          `The agent goes offline, its volume is replaced by the pre-update backup ${update?.backupFile ?? ''} ` +
          'and it starts again on the previous version. Everything the agent did after that backup is lost.'
        }
        confirmLabel="Roll back"
        cancelLabel="Cancel"
        tone="danger"
      />
    </div>
  );
}
