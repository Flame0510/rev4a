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
import { Accordion, Badge, Button, ConfirmModal, Input, Modal } from '../components/ui';
import { backupWasDeleted, isResolvedFailure, offersRollback, offersRollbackAnyway, showsRedFailure } from '@/lib/agent-update-resolution';
import { SkeletonLines } from '../components/Skeleton';
import { needsInferenceAccountAdoptionNotice } from '@/lib/control-ui-navigation';

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
  /** A recreate or restore that finished after this failed or interrupted update: its rollback undoes it too. */
  laterJob: { kind: 'recreate' | 'restore'; atMs: number } | null;
  /** Set when a failed or interrupted update was later proved fine on the target version. */
  resolvedAtMs: number | null;
  resolution: string | null;
  /** The pre-update backup still exists (checked only while a rollback could be offered); null = unknown. */
  backupAvailable: boolean | null;
  cronAccountAdoption?: { note: string } | null;
}

interface HistoryEntry {
  id: number;
  status: UpdateStatus;
  fromVersion: string | null;
  toVersion: string;
  error: string | null;
  resolution: string | null;
  resolvedAtMs: number | null;
  backupFile: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

interface UpdateInfo {
  currentVersion: string | null;
  candidate: { fromVersion: string; toVersion: string } | null;
  update: UpdateView | null;
  history?: HistoryEntry[];
}

type Action = 'update' | 'rollback' | 'rollbackAnyway';

const ACTIVE: UpdateStatus[] = ['pending', 'backing_up', 'migrating', 'verifying', 'rolling_back'];
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

/** "12/10/2026, 11 days ago": the date a backup was taken and how long ago that is. */
function dateAndAge(ms: number | null): string {
  if (!ms) return 'the day of the update';
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  const ago = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `${new Date(ms).toLocaleDateString()}, ${ago}`;
}

/** A recreate or restore after a failed update: the rollback undoes it too. */
function laterJobText(job: NonNullable<UpdateView['laterJob']>): string {
  return `The agent was ${job.kind === 'restore' ? 'restored' : 'recreated'} on ${when(job.atMs)}, after this update.`;
}

export default function UpdateSection({
  agentId,
  displayName,
  running,
  onChanged,
  onStarted,
  backupsChanged = 0,
}: {
  agentId: string;
  /** Incremented by the Backup section after a delete, restore or backup: the update state is read again. */
  backupsChanged?: number;
  /** The name the operator sees (AGENT_NAME); the "Roll back anyway" confirmation asks for it. Falls back to agentId. */
  displayName?: string;
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
  const [typedName, setTypedName] = useState('');
  const confirmName = (displayName ?? '').trim() || agentId;
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastStatus = useRef<UpdateStatus | null>(null);

  const load = useCallback(async (fresh = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/update${fresh ? '?fresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' });
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
    if (backupsChanged > 0) void load(true);
  }, [backupsChanged, load]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  // An unresolved failure is re-checked by Rev4a in the background (lib/agent-update.ts), which can
  // take tens of seconds (probe, transcripts, cron list): read again a few times, so a failure proved
  // harmless turns muted without a manual reload. Bounded: three reads, then the normal panel reads.
  const failedId = update && showsRedFailure(update) ? update.id : null;
  useEffect(() => {
    if (failedId === null) return;
    const timers = [8_000, 25_000, 60_000].map((ms) => setTimeout(() => { void load(); }, ms));
    return () => timers.forEach(clearTimeout);
  }, [failedId, load]);

  const run = async (action: Action) => {
    setConfirming(null);
    setTypedName('');
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
        setActionError(data?.error ?? `Could not start the ${action === 'update' ? 'update' : 'rollback'} (HTTP ${res.status})`);
      } else {
        onStarted?.();
      }
    } catch {
      setActionError(`Could not start the ${action === 'update' ? 'update' : 'rollback'}`);
    }
    busyRef.current = null;
    setBusy(null);
    void load();
  };

  if (!info && !loadError) return <SkeletonLines count={2} />;

  const candidate = info?.candidate ?? null;
  const stepIndex = update ? STEPS.findIndex((s) => s.status === update.status) : -1;
  const canRollBack = !!update && offersRollback(update, active);
  const canRollBackAnyway = !!update && offersRollbackAnyway(update, active);
  const backupDeleted = !!update && backupWasDeleted(update, active);
  const deletedText = update
    ? `The pre-update backup (${when(update.startedAtMs) || 'date unknown'}) was deleted: going back to OpenClaw ${update.fromVersion} is no longer possible.`
    : '';
  const history = info?.history ?? [];

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
          {update.status === 'pending' && <div style={metaStyle}>Waiting for the agent to finish starting…</div>}
          {update.error && <div style={metaStyle}>{update.error}</div>}
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
          {update.cronAccountAdoption && <div style={metaStyle}>{update.cronAccountAdoption.note}</div>}
        </div>
      )}

      {update && showsRedFailure(update) && (
        <div style={{ margin: '6px 0 10px' }}>
          <Badge tone="danger">
            <span style={{ fontSize: 10 }}>
              Update to OpenClaw {update.toVersion} {update.status === 'interrupted' ? 'was interrupted' : 'failed'}
            </span>
          </Badge>
          {update.error && <div style={metaStyle}>{update.error}</div>}
          {update.laterJob && <div style={metaStyle}>{laterJobText(update.laterJob)} A rollback undoes that too.</div>}
          {update.verification && update.verification.lostEvents.length > 0 && (
            <div style={metaStyle}>
              {update.verification.lostEvents.map((l) => `${l.session}: ${l.before} → ${l.after}`).join(' · ')}
            </div>
          )}
          {update.backupFile && <div style={metaStyle}>Pre-update backup: {update.backupFile}</div>}
        </div>
      )}

      {update && isResolvedFailure(update) && (
        <div style={{ margin: '6px 0 10px' }}>
          <div style={metaStyle}>
            The update to OpenClaw {update.toVersion} on {when(update.startedAtMs)} reported: {update.error ?? update.status}.
            {' '}Since then: {update.resolution ?? 'verified against its baseline'} ({when(update.resolvedAtMs)}).
          </div>
          {update.backupFile && <div style={metaStyle}>Pre-update backup: {update.backupFile}</div>}
          {canRollBackAnyway && (
            <div style={{ marginTop: 6 }}>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'rollbackAnyway'}
                disabled={busy !== null}
                onClick={() => { void load(true); setTypedName(''); setConfirming('rollbackAnyway'); }}
              >
                {busy === 'rollbackAnyway' ? 'Starting…' : 'Roll back anyway…'}
              </Button>
            </div>
          )}
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

      {backupDeleted && <div style={{ ...metaStyle, margin: '6px 0 10px' }}>{deletedText}</div>}

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
            onClick={() => { void load(true); setConfirming('rollback'); }}
          >
            {busy === 'rollback' ? 'Starting…' : `Roll back to ${update.fromVersion}`}
          </Button>
        )}
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Accordion
            title="Update history"
            summary={`${history.length} update${history.length === 1 ? '' : 's'}`}
            open={historyOpen}
            onToggle={() => setHistoryOpen((v) => !v)}
          >
            {history.map((h) => (
              <div key={h.id} style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text)' }}>
                  {when(h.startedAtMs)} · {h.fromVersion ?? 'unknown'} → {h.toVersion} · {h.status.replace(/_/g, ' ')}
                </div>
                {h.error && <div style={metaStyle}>{h.error}</div>}
                {h.resolution && <div style={metaStyle}>Resolved ({when(h.resolvedAtMs)}): {h.resolution}</div>}
                {h.backupFile && (
                  <div style={metaStyle}>
                    Backup: {h.backupFile}, the agent's data from before this update. Going back to the previous version is the Roll back of the latest update; older updates cannot be rolled back.
                  </div>
                )}
              </div>
            ))}
          </Accordion>
        </div>
      )}

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
          'and anything the agent does after the update is lost.' +
          (needsInferenceAccountAdoptionNotice(candidate?.fromVersion, candidate?.toVersion)
            ? '\n\nWith exactly one connected ChatGPT/Codex account, Rev4a associates affected cron jobs with it and preserves model inheritance. ' +
              'With zero or several accounts, or if adoption fails, legacy LLM automations can require explicit account adoption. ' +
              'Subscriptions shows account references. In the automation settings in OpenClaw, select a model/account reference and save. ' +
              'Choose Default and save again when the job should keep following the agent model. Verify a run before resuming a paused job.'
            : '')
        }
        confirmLabel="Update"
        cancelLabel="Cancel"
      />
      <Modal
        open={backupDeleted && (confirming === 'rollback' || confirming === 'rollbackAnyway')}
        onClose={() => { setConfirming(null); setTypedName(''); }}
        title="Roll back is no longer possible"
        tone="warning"
        maxWidth={420}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#aaa', marginBottom: 16 }}>{deletedText}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={() => { setConfirming(null); setTypedName(''); }}>Close</Button>
        </div>
      </Modal>
      <ConfirmModal
        open={confirming === 'rollback' && !backupDeleted}
        onClose={() => setConfirming(null)}
        onConfirm={() => { void run('rollback'); }}
        title={update?.fromVersion ? `Roll back to OpenClaw ${update.fromVersion}?` : 'Roll back?'}
        message={
          `The agent goes offline, its volume is replaced by the pre-update backup ${update?.backupFile ?? ''} ` +
          `taken on ${when(update?.startedAtMs ?? null) || 'the day of the update'}, and it starts again on the previous version. ` +
          `Everything the agent did since that backup is lost.` +
          (update?.laterJob ? ` ${laterJobText(update.laterJob)} The rollback undoes that too.` : '')
        }
        confirmLabel="Roll back"
        cancelLabel="Cancel"
        tone="danger"
      />
      <Modal
        open={confirming === 'rollbackAnyway' && !backupDeleted}
        onClose={() => { setConfirming(null); setTypedName(''); }}
        title={update?.fromVersion ? `Roll back to OpenClaw ${update.fromVersion} anyway?` : 'Roll back anyway?'}
        tone="danger"
        maxWidth={460}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#aaa', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
          {`This update was checked and the agent works on OpenClaw ${update?.toVersion ?? 'the new version'}. ` +
            `Rolling back replaces its whole volume with the pre-update backup ${update?.backupFile ?? ''}, taken on ${dateAndAge(update?.startedAtMs ?? null)}, ` +
            `and starts it again on OpenClaw ${update?.fromVersion ?? 'the previous version'}.\n\n` +
            `EVERYTHING the agent did since that date is lost: conversations, memory, workspace files and cron changes. The agent is offline until it finishes.`}
        </div>
        <Input
          label={`Type the agent's name (${confirmName}) to confirm`}
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="secondary" size="sm" onClick={() => { setConfirming(null); setTypedName(''); }}>Cancel</Button>
          <Button
            variant="danger"
            size="sm"
            disabled={typedName.trim() !== confirmName}
            onClick={() => { void run('rollbackAnyway'); }}
          >
            Roll back and lose newer data
          </Button>
        </div>
      </Modal>
    </div>
  );
}
