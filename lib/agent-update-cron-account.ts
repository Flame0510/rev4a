/** One-time, best-effort native inference-account adoption for the evaluated 9.x -> 10.10 migration. */
import { dockerExec } from '@/lib/docker-exec';
import { gatewayCliArgv } from '@/lib/gateway-cli';
import { readProfiles } from '@/lib/subscriptions';
import { claimCronModelRepair } from '@/lib/agent-job-state';
import { cronModelJournal, pendingCronModelUpdates, type CronModelJournal, type CronModelRecord } from '@/lib/cron-account-adoption-state';

interface Candidate {
  id: string;
  model: string | null;
  effectiveModel: string | null;
  bound: boolean;
  account: string | null;
  native: boolean;
}
export interface CronAccountAdoption {
  associated: number;
  noBindingNeeded: number;
  alreadyAssociated: number;
  skipped: number;
  failed: number;
  note: string;
}
interface Ports {
  journal: CronModelJournal;
  profiles(): Promise<{ id: string }[]>;
  candidates(): Promise<Candidate[]>;
  isCliRoute(jobId: string, modelRef: string): Promise<boolean>;
  call(method: string, params: Record<string, unknown>): Promise<NativeJob>;
}
interface NativeJob { id: string; configRevision: string; payload: { kind: string; model?: string | null }; }

/** Read only safe metadata. Public cron.list intentionally hides inferenceBinding (10.10 public-job). */
export const CRON_ACCOUNT_CANDIDATES = `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
const db = new DatabaseSync('/root/.openclaw/state/openclaw.sqlite', { readOnly: true });
try {
  const primary = m => typeof m === 'string' ? m : m?.primary ?? null;
  const defaults = cfg.agents?.defaults?.model;
  const agents = cfg.agents?.list ?? [];
  const hasNative = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cron_job_runtime_authorities'").get();
  const nativeIds = new Set(hasNative ? db.prepare('SELECT job_id FROM cron_job_runtime_authorities').all().map(r => r.job_id) : []);
  const jobs = db.prepare('SELECT job_json FROM cron_jobs').all().map(row => JSON.parse(row.job_json));
  const out = jobs.filter(j => j.payload?.kind === 'agentTurn' && j.sessionTarget !== 'main').map(j => {
    const agent = j.agentId ? agents.find(a => a.id === j.agentId) : (agents.find(a => a.default === true) ?? agents[0]);
    const model = j.payload.model ?? null;
    return { id: j.id, model, effectiveModel: model || primary(agent?.model) || primary(defaults),
      bound: !!j.inferenceBinding, account: typeof j.inferenceBinding?.profileId === 'string' ? j.inferenceBinding.profileId : null, native: nativeIds.has(j.id) || !!j.runtimeAuthority || j.runtimeAuthorityRecoveryRequired === true };
  });
  process.stdout.write(JSON.stringify(out));
} finally { db.close(); }
`;

/** Use the evaluated runtime's own pre-mutation CLI rule, including model policy and auth aliases. */
export const CRON_ACCOUNT_CLI_ROUTE = String.raw`
(async () => {
  const fs = require('node:fs');
  const { pathToFileURL } = require('node:url');
  const { DatabaseSync } = require('node:sqlite');
  const [jobId, modelRef] = process.argv.slice(1);
  const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
  const dist = '/usr/local/lib/node_modules/openclaw/dist/';
  const capability = async (prefix, name) => {
    for (const file of fs.readdirSync(dist).filter(file => file.startsWith(prefix) && file.endsWith('.mjs')).sort()) {
      const mod = await import(pathToFileURL(dist + file).href);
      const fn = Object.values(mod).find(value => typeof value === 'function' && value.name === name);
      if (fn) return fn;
    }
    throw new Error('Cron route classification unavailable');
  };
  const defaultAgent = await capability('agent-scope-config-', 'resolveDefaultAgentId');
  const select = await capability('simple-completion-selection-', 'resolveSimpleCompletionSelectionForAgent');
  const cli = await capability('model-runtime-aliases-', 'resolveCliRuntimeExecutionProvider');
  const db = new DatabaseSync('/root/.openclaw/state/openclaw.sqlite', { readOnly: true });
  let job;
  try { job = db.prepare('SELECT job_json FROM cron_jobs').all().map(row => JSON.parse(row.job_json)).find(job => job.id === jobId); }
  finally { db.close(); }
  if (!job || job.payload?.kind !== 'agentTurn') throw new Error('Cron job unavailable');
  const agentId = job.agentId ?? defaultAgent(cfg);
  const selection = select({ cfg, agentId, modelRef });
  if (!selection?.profileId) throw new Error('Cron selection unavailable');
  process.stdout.write(JSON.stringify(Boolean(cli({ cfg, agentId, provider: selection.provider,
    modelId: selection.modelId, authProfileId: selection.profileId }))));
})().catch(() => { process.stderr.write('Cron route classification unavailable'); process.exitCode = 1; });
`;

function nativeJob(value: unknown): NativeJob {
  if (!value || typeof value !== 'object') throw new Error('Unreadable native cron response');
  const job = value as NativeJob;
  if (typeof job.id !== 'string' || typeof job.configRevision !== 'string' || job.payload?.kind !== 'agentTurn') throw new Error('Unreadable native cron response');
  return job;
}

function productionPorts(container: string, updateId: number): Ports {
  return {
    journal: cronModelJournal(container, updateId),
    profiles: () => readProfiles(container, { retry: false }),
    candidates: async () => JSON.parse(await dockerExec(container, ['node', '-e', CRON_ACCOUNT_CANDIDATES], { timeoutMs: 12_000 })),
    isCliRoute: async (jobId, modelRef) => {
      const value: unknown = JSON.parse(await dockerExec(container, ['node', '-e', CRON_ACCOUNT_CLI_ROUTE, jobId, modelRef], { timeoutMs: 12_000 }));
      if (typeof value !== 'boolean') throw new Error('Unreadable cron route');
      return value;
    },
    call: async (method, params) => {
      const out = await dockerExec(container, gatewayCliArgv(['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '20000']), { timeoutMs: 25_000 });
      // CLI logs can precede its JSON result. Never include native output in the persisted note.
      const start = out.indexOf('{');
      return nativeJob(JSON.parse(start < 0 ? out : out.slice(start)));
    },
  };
}

/** A fresh revision guards every clear, including recovery after an ambiguous native commit. */
async function restoreOriginalModel(job: Candidate, record: CronModelRecord, ports: Ports): Promise<'associated' | 'noBindingNeeded' | null> {
  // OpenClaw's captureCronUpdatedInferenceBinding skips a new binding for CLI execution.
  // An exact journaled pin is still ours to undo on that route after a lost response.
  if (record.superseded_at != null || job.native || (job.bound && job.account !== record.profile_id)) return null;
  let current = nativeJob(await ports.call('cron.get', { id: job.id }));
  if (current.id !== job.id) throw new Error('Mismatched native cron response');
  const model = current.payload.model ?? null;
  const fresh = (await ports.candidates()).find(candidate => candidate.id === job.id);
  if (!fresh || fresh.native || (fresh.bound && fresh.account !== record.profile_id) || fresh.model !== model) return null;
  if (model !== record.original_model && model !== record.temporary_model) return null; // The operator chose another model.
  const noBindingNeeded = !fresh.bound && await ports.isCliRoute(job.id, record.temporary_model);
  if (!fresh.bound && !noBindingNeeded) {
    // An unchanged original model does not prove selection committed. Retry the
    // recorded selection under a fresh revision rather than completing unknown intent.
    current = nativeJob(await ports.call('cron.update', { id: job.id, expectedConfigRevision: current.configRevision,
      patch: { payload: { kind: 'agentTurn', model: record.temporary_model } } }));
    if (current.id !== job.id || current.payload.model !== record.temporary_model) throw new Error('Unexpected adoption response');
  }
  if ((current.payload.model ?? null) !== record.original_model) {
    const restored = nativeJob(await ports.call('cron.update', { id: job.id, expectedConfigRevision: current.configRevision,
      patch: { payload: { kind: 'agentTurn', model: record.original_model } } }));
    if (restored.id !== job.id || (restored.payload.model ?? null) !== record.original_model) throw new Error('Model inheritance was not restored');
  }
  return finishVerifiedModel(job.id, record, ports, noBindingNeeded);
}

/** Public RPC responses omit bindings. Verify the persisted binding and original model after saving. */
async function finishVerifiedModel(jobId: string, record: CronModelRecord, ports: Ports, noBindingNeeded: boolean): Promise<'associated' | 'noBindingNeeded'> {
  const fresh = (await ports.candidates()).find(candidate => candidate.id === jobId);
  if (!fresh || fresh.native || fresh.model !== record.original_model || (fresh.bound ? fresh.account !== record.profile_id : !noBindingNeeded)) {
    throw new Error('Cron model or inference account could not be verified');
  }
  ports.journal.finish(jobId);
  return fresh.bound && fresh.account === record.profile_id ? 'associated' : 'noBindingNeeded';
}

async function runAdoption(ports: Ports, allowAdoption: boolean): Promise<CronAccountAdoption> {
  const result: CronAccountAdoption = { associated: 0, noBindingNeeded: 0, alreadyAssociated: 0, skipped: 0, failed: 0, note: '' };
  try {
    const jobs = await ports.candidates();
    if (!Array.isArray(jobs)) throw new Error('Unreadable cron metadata');
    // Recovery of a recorded selection does not depend on today's connected-account count.
    const profiles = allowAdoption ? await ports.profiles().catch(() => null) : null;
    const deadline = Date.now() + 120_000;
    for (const job of jobs) {
      if (Date.now() >= deadline) { result.failed++; continue; }
      let record = ports.journal.get(job.id);
      try {
        if (record?.superseded_at != null) { result.skipped++; continue; }
        if (record && record.finished_at === null) {
          const outcome = await restoreOriginalModel(job, record, ports);
          if (outcome) result[outcome]++;
          else result.skipped++;
          continue;
        }
        if (job.bound) { result.alreadyAssociated++; continue; }
        if (record?.finished_at != null) {
          if (job.model === record.original_model && !job.native && await ports.isCliRoute(job.id, record.temporary_model)) result.noBindingNeeded++;
          else result.skipped++;
          continue;
        }
        if (!allowAdoption || !profiles || profiles.length !== 1 || job.native || !job.effectiveModel || !/^(openai|openai-codex)\//.test(job.effectiveModel) || job.effectiveModel.includes('@')) { result.skipped++; continue; }
        const temporaryModel = `${job.effectiveModel}@${profiles[0].id}`;
        // OpenClaw creates no binding on the CLI route, so selecting the account there changes nothing the job
        // needs: decide before any read or mutation, so no journal is written and nothing can fail half-way.
        if (await ports.isCliRoute(job.id, temporaryModel)) { result.noBindingNeeded++; continue; }
        const current = nativeJob(await ports.call('cron.get', { id: job.id }));
        if (current.id !== job.id || (current.payload.model ?? null) !== job.model) { result.skipped++; continue; }
        const fresh = (await ports.candidates()).find(candidate => candidate.id === job.id);
        if (!fresh || fresh.bound || fresh.native || fresh.model !== job.model) { result.skipped++; continue; }
        record = ports.journal.remember({ job_id: job.id, profile_id: profiles[0].id,
          original_model: job.model, temporary_model: temporaryModel });
        if (record.finished_at !== null || record.original_model !== job.model || record.profile_id !== profiles[0].id) { result.skipped++; continue; }
        const noBindingNeeded = false;
        // The journal is committed BEFORE this call. A lost response leaves recoverable intent.
        const selected = nativeJob(await ports.call('cron.update', { id: job.id, expectedConfigRevision: current.configRevision,
          patch: { payload: { kind: 'agentTurn', model: record.temporary_model } } }));
        if (selected.id !== job.id || selected.payload.model !== record.temporary_model) throw new Error('Unexpected adoption response');
        const restored = nativeJob(await ports.call('cron.update', { id: job.id, expectedConfigRevision: selected.configRevision,
          patch: { payload: { kind: 'agentTurn', model: record.original_model } } }));
        if (restored.id !== job.id || (restored.payload.model ?? null) !== record.original_model) throw new Error('Model inheritance was not restored');
        result[await finishVerifiedModel(job.id, record, ports, noBindingNeeded)]++;
      } catch {
        // Keep durable intent unfinished. The next pass re-reads ownership/model and uses
        // a fresh revision; never guess whether a rejected transport committed its mutation.
        result.failed++;
      }
    }
    if (allowAdoption && !profiles) result.failed++;
    result.note = `Cron inference accounts: associated ${result.associated} job(s); ${result.noBindingNeeded} no binding needed (model left/restored), ${result.alreadyAssociated} already associated, ${result.skipped} unchanged, ${result.failed} failed. Completed jobs preserve Default primary-model and fallback inheritance or their explicit model.`;
    if (allowAdoption && profiles?.length !== 1) result.note += ' Select the intended account for affected jobs in OpenClaw.';
    if (allowAdoption && !profiles) result.note += ' Account discovery failed; the update succeeded. Select the intended account in OpenClaw.';
    if (result.failed) result.note += ' Pending temporary model overrides will be reconciled again; review affected jobs in OpenClaw.';
  } catch {
    result.failed++;
    result.note = 'Cron inference account adoption could not be completed. The update succeeded; select the intended account for affected jobs in OpenClaw.';
  }
  return result;
}

export async function adoptCronInferenceAccount(container: string, fromVersion: string, toVersion: string, updateId: number, ports: Ports = productionPorts(container, updateId)): Promise<CronAccountAdoption | null> {
  if (!/^2026\.9\.\d+$/.test(fromVersion) || toVersion !== '2026.10.10') return null;
  return runAdoption(ports, true);
}

/** Startup/periodic repair completes journaled selections; it never adopts additional jobs. */
export async function reconcilePendingCronAccountModels(): Promise<void> {
  for (const { container, update_id } of pendingCronModelUpdates()) {
    // Recheck the latest update and every lifecycle owner atomically after discovery.
    const release = await claimCronModelRepair(update_id);
    if (!release) continue;
    try {
      const result = await runAdoption(productionPorts(container, update_id), false);
      if (result.associated || result.noBindingNeeded || result.failed) console.warn(`[update] Cron model reconciliation: ${result.associated} associated, ${result.noBindingNeeded} no binding needed, ${result.failed} failed`);
    } finally { release(); }
  }
}

let repairTimer: ReturnType<typeof setInterval> | undefined;
export function startCronAccountModelRecovery(): void {
  if (repairTimer) return;
  let checking = false;
  const retry = async () => {
    if (checking) return;
    checking = true;
    try { await reconcilePendingCronAccountModels(); }
    catch { console.warn('[update] Pending cron model recovery will retry'); }
    finally { checking = false; }
  };
  void retry();
  repairTimer = setInterval(() => { void retry(); }, 60_000);
  repairTimer.unref();
}
