/** Bounded Docker-only admission. Never starts an OpenClaw CLI or changes a container's limit. */
import { dockerRequestJson } from '@/lib/docker-socket-path';
import { workingSetBytes, MB } from '@/lib/docker-stats';
import {
  evaluateAgentResources, memoryLimitPolicyError, resourcePolicyFor,
  type ResourceAdmission, type ResourceBreakdown, type ResourceContainer, type ResourceRefusal,
} from '@/lib/agent-resource-policy';

export interface AgentResourceRequest {
  version: string;
  operation: 'create' | 'update';
  targetAgentId: string;
  limitMb: number | null;
}
export interface DockerResourceFacts { dockerTotalMb: number | null; dockerDesktop: boolean; containers: ResourceContainer[] }
export type ResourceFactsReader = () => Promise<DockerResourceFacts>;
export type AgentResourcePreview = { ok: true; breakdown: ResourceBreakdown } | ResourceRefusal;
type DockerReader = (path: string, timeoutMs: number) => Promise<unknown>;
const REQUEST_MS = 5000;
const TOTAL_MS = 12000;
const MAX_CONTAINERS = 128;
const CONCURRENCY = 4;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AgentResourceRefusedError extends Error {
  constructor(message: string, public readonly code: string, public readonly breakdown?: ResourceBreakdown) {
    super(message);
  }
}

/** All running containers, not a stale daemon sample. Limits suffice for bounded agents. */
export async function readDockerResourceFacts(
  read: DockerReader = (apiPath, timeoutMs) => dockerRequestJson('GET', apiPath, timeoutMs),
): Promise<DockerResourceFacts> {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + TOTAL_MS;
  const request = (apiPath: string): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (cancelled || remaining <= 0) throw new Error('Docker resource preflight timed out');
    return read(apiPath, Math.min(REQUEST_MS, remaining));
  };
  const work = async (): Promise<DockerResourceFacts> => {
    const [info, listed] = await Promise.all([request('/info'), request('/containers/json')]);
    if (!object(info) || typeof info.MemTotal !== 'number' || !Number.isFinite(info.MemTotal) || info.MemTotal <= 0
      || !Array.isArray(listed) || listed.length > MAX_CONTAINERS) throw new Error('Docker resource facts are incomplete');
    const containers: ResourceContainer[] = [];
    const seen = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < listed.length) {
        const item: unknown = listed[next++];
        if (!object(item) || typeof item.Id !== 'string' || !/^[a-f0-9]{12,64}$/.test(item.Id) || seen.has(item.Id)) throw new Error('Docker container list is unreadable');
        seen.add(item.Id);
        const inspected = await request(`/containers/${item.Id}/json`);
        if (!object(inspected) || !object(inspected.State) || inspected.State.Running !== true
          || !object(inspected.HostConfig) || typeof inspected.HostConfig.Memory !== 'number'
          || !Number.isFinite(inspected.HostConfig.Memory) || inspected.HostConfig.Memory < 0
          || !object(inspected.Config)) throw new Error('A running container changed or could not be inspected; retry');
        const labels = object(inspected.Config.Labels) ? inspected.Config.Labels : {};
        const agentId = typeof labels.AGENT_ID === 'string' && labels.AGENT_ID.length > 0 ? labels.AGENT_ID : null;
        const env = inspected.Config.Env;
        const nameEntry = agentId && Array.isArray(env)
          ? env.find((entry): entry is string => typeof entry === 'string' && entry.startsWith('AGENT_NAME='))
          : undefined;
        const rawName = agentId ? nameEntry?.slice('AGENT_NAME='.length)
          : typeof inspected.Name === 'string' ? inspected.Name.replace(/^\//, '') : undefined;
        const cleanName = (rawName ?? '').replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, '').trim();
        const name = Array.from(cleanName).slice(0, 80).join('') || null;
        const limitMb = inspected.HostConfig.Memory > 0 ? inspected.HostConfig.Memory / MB : null;
        let usageMb: number | null = null;
        if (!agentId || limitMb === null) {
          const stats = await request(`/containers/${item.Id}/stats?stream=false&one-shot=true`);
          if (object(stats) && object(stats.memory_stats) && typeof stats.memory_stats.usage === 'number'
            && Number.isFinite(stats.memory_stats.usage) && stats.memory_stats.usage >= 0) {
            const bytes = workingSetBytes(stats.memory_stats);
            if (bytes !== null && Number.isFinite(bytes) && bytes >= 0) usageMb = Math.ceil(bytes / MB);
          }
        }
        containers.push({ agentId, name, limitMb, usageMb });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listed.length) }, worker));
    return { dockerTotalMb: Math.floor(info.MemTotal / MB), dockerDesktop: info.OperatingSystem === 'Docker Desktop', containers };
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new Error('Docker resource preflight timed out')); }, TOTAL_MS);
    })]);
  } finally {
    cancelled = true;
    if (timer) clearTimeout(timer);
  }
}

interface AdmissionClaim { token: symbol; reservedMb: number }
const shared = globalThis as unknown as { __rev4aResourceAdmissions?: Map<string, AdmissionClaim> };
const claims = (shared.__rev4aResourceAdmissions ??= new Map<string, AdmissionClaim>());

async function checkAgentResources<T>(
  input: AgentResourceRequest,
  readFacts: ResourceFactsReader,
  onAdmitted: (decision: Extract<ResourceAdmission, { ok: true }>) => T,
): Promise<T | ResourceRefusal> {
  const duplicate: ResourceRefusal = { ok: false, code: 'duplicate-claim', error: 'An operation already reserves resources for this agent' };
  if (claims.has(input.targetAgentId)) return duplicate;
  if (!resourcePolicyFor(input.version).known) {
    return { ok: false, code: 'unknown-version', error: 'Resource requirements for this OpenClaw version have not been evaluated; nothing was changed' };
  }
  const limitError = memoryLimitPolicyError(input.version, input.limitMb);
  if (limitError) return { ok: false, code: 'limit-too-low', error: limitError };
  let facts: DockerResourceFacts;
  try { facts = await readFacts(); }
  catch {
    return { ok: false, code: 'unknown-host', error: 'Docker memory capacity or running-container statistics could not be read. Check Docker and retry; nothing was changed.' };
  }
  if (claims.has(input.targetAgentId)) return duplicate;
  const target = facts.containers.filter((container) => container.agentId === input.targetAgentId);
  if (target.length > 1 || input.operation === 'create' && target.length !== 0
    || input.operation === 'update' && (target.length !== 1 || target[0].limitMb !== input.limitMb)) {
    return { ok: false, code: 'target-changed', error: 'The agent state or memory limit changed during preflight. Refresh and retry; nothing was changed.' };
  }
  const decision = evaluateAgentResources({ ...input, ...facts, targetUsageMb: target[0]?.usageMb,
    reservations: [...claims].map(([agentId, claim]) => ({ agentId, reservedMb: claim.reservedMb })),
  });
  // Keep evaluation and any claim in the same turn to avoid spending the same headroom twice.
  return decision.ok ? onAdmitted(decision) : decision;
}

export function previewAgentResources(input: AgentResourceRequest, readFacts: ResourceFactsReader = readDockerResourceFacts): Promise<AgentResourcePreview> {
  return checkAgentResources(input, readFacts, ({ breakdown }) => ({ ok: true as const, breakdown }));
}

export async function acquireAgentResourcePreflight(input: AgentResourceRequest, readFacts: ResourceFactsReader = readDockerResourceFacts): Promise<() => void> {
  const result = await checkAgentResources(input, readFacts, ({ targetReserveMb }) => {
    const token = Symbol(input.targetAgentId);
    claims.set(input.targetAgentId, { token, reservedMb: targetReserveMb });
    return () => { if (claims.get(input.targetAgentId)?.token === token) claims.delete(input.targetAgentId); };
  });
  if (typeof result === 'function') return result;
  throw new AgentResourceRefusedError(result.error, result.code, result.breakdown);
}
