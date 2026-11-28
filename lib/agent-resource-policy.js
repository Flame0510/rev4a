'use strict';

/** Shared resource guidance/admission arithmetic. Pure: no Docker, files, clocks or defaults. */
const HEADROOM_MB = 1024;
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const usage = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const gb = (mb, withUnit = true) => `${Number((mb / 1024).toFixed(2))}${withUnit ? ' GB' : ''}`;

function resourcePolicyFor(version) {
  if (version === '2026.10.10') return {
    known: true, reserveMb: 4096, minimumLimitMb: 4096,
    advice: 'OpenClaw 2026.10.10 exceeded 2 GB during compatibility checks and 3 GB during repeated CLI configuration and model checks. The remaining case passed at 4 GB. Create and Update require at least 4 GB when a limit is set; larger workloads may need more.',
  };
  if (version === '2026.9.3' || version === '2026.9.9') return {
    known: true, reserveMb: 2048, minimumLimitMb: null,
    advice: `OpenClaw ${version}: below 2 GB the agent may be killed while it starts or works. A memory limit remains your choice.`,
  };
  return {
    known: false, reserveMb: 3072, minimumLimitMb: null,
    advice: 'Memory requirements depend on the OpenClaw version. Allow at least 3 GB for planning newer agents; this is not a guarantee for every version or workload.',
  };
}

function memoryLimitPolicyError(version, limitMb) {
  const policy = resourcePolicyFor(version);
  return limitMb !== null && policy.minimumLimitMb !== null && limitMb < policy.minimumLimitMb
    ? `OpenClaw ${version} needs a limit of at least ${gb(policy.minimumLimitMb)} for Create or Update. Change the memory limit explicitly, then retry; the current limit has not been changed.`
    : '';
}

function evaluateAgentResources(input) {
  const policy = resourcePolicyFor(input.version);
  const fail = (code, error) => ({ ok: false, code, error });
  if (!policy.known) return fail('unknown-version', 'Resource requirements for this OpenClaw version have not been evaluated. Nothing was created, stopped or backed up.');
  if (input.limitMb !== null && !positive(input.limitMb)) return fail('unknown-limit', 'The agent memory limit could not be read. Refresh and retry; nothing was changed.');
  const limitError = memoryLimitPolicyError(input.version, input.limitMb);
  if (limitError) return fail('limit-too-low', limitError);
  if (!positive(input.dockerTotalMb)) return fail('unknown-host', 'Docker memory capacity could not be read. Check that Docker is available, then retry; nothing was changed.');
  if (input.operation === 'update' && input.limitMb === null && !usage(input.targetUsageMb)) {
    return fail('unknown-usage', 'The current memory usage of this unlimited agent could not be read. Retry once Docker statistics are available; nothing was changed.');
  }
  const targetReserveMb = input.limitMb === null
    ? Math.max(policy.reserveMb, usage(input.targetUsageMb) ? input.targetUsageMb + HEADROOM_MB : 0)
    : input.limitMb;
  const targetBasis = input.limitMb !== null ? 'limit' : targetReserveMb > policy.reserveMb ? 'usage' : 'policy';
  const claims = new Map();
  for (const claim of input.reservations ?? []) {
    if (!claim || typeof claim.agentId !== 'string' || !positive(claim.reservedMb)) return fail('unknown-reservation', 'An in-flight agent resource reservation is unreadable. Retry after the operation ends.');
    claims.set(claim.agentId, Math.max(claims.get(claim.agentId) ?? 0, claim.reservedMb));
  }
  claims.delete(input.targetAgentId);
  const activeClaimIds = new Set(claims.keys());
  const others = [];
  let otherReserveMb = 0;
  for (const container of input.containers ?? []) {
    if (container.agentId === input.targetAgentId) continue;
    let reserved;
    let basis = 'usage';
    if (container.agentId) {
      if (container.limitMb !== null && !positive(container.limitMb)) return fail('unknown-limit', 'Another running agent has an unreadable memory limit. Retry once Docker can inspect every running agent.');
      if (container.limitMb !== null) {
        reserved = container.limitMb;
        basis = 'limit';
      } else if (usage(container.usageMb)) reserved = container.usageMb + HEADROOM_MB;
      else return fail('unknown-usage', 'Memory usage of another unlimited agent could not be read. Stop it or retry once Docker statistics are available.');
    } else if (usage(container.usageMb)) reserved = container.usageMb;
    else if (positive(container.limitMb)) {
      reserved = container.limitMb;
      basis = 'limit';
    } else return fail('unknown-usage', 'Memory usage of another running container could not be read. Retry once Docker statistics are available.');
    if (container.agentId && claims.has(container.agentId)) {
      const claimedMb = claims.get(container.agentId);
      if (claimedMb > reserved) basis = 'claim';
      reserved = Math.max(reserved, claimedMb);
      claims.delete(container.agentId);
    }
    otherReserveMb += reserved;
    others.push({
      agentId: container.agentId, name: container.name ?? null, reservedMb: reserved,
      basis, kind: container.agentId ? 'agent' : 'container',
      ...(container.agentId && activeClaimIds.has(container.agentId) ? { claimed: true } : {}),
    });
  }
  for (const [agentId, reservedMb] of claims) {
    otherReserveMb += reservedMb;
    others.push({ agentId, name: null, reservedMb, basis: 'claim', kind: 'agent' });
  }
  const requiredMb = targetReserveMb + otherReserveMb + HEADROOM_MB;
  const shortfallMb = Math.max(0, requiredMb - input.dockerTotalMb);
  others.sort((a, b) => b.reservedMb - a.reservedMb);
  const stopAgent = shortfallMb > 0
    ? others.findLast((entry) => entry.kind === 'agent' && !entry.claimed && entry.basis !== 'claim' && entry.reservedMb >= shortfallMb)
    : undefined;
  const dockerMemoryGb = Math.ceil((requiredMb + 512) / 1024);
  const breakdown = {
    dockerTotalMb: input.dockerTotalMb, requiredMb, shortfallMb, headroomMb: HEADROOM_MB,
    target: { reserveMb: targetReserveMb, basis: targetBasis },
    others,
    suggestion: {
      stopAgentId: stopAgent?.agentId ?? null,
      stopAgentName: stopAgent?.name ?? null,
      freesMb: stopAgent?.reservedMb ?? null,
      dockerMemoryGb,
    },
  };
  if (requiredMb > input.dockerTotalMb) {
    const agent = input.operation === 'create' ? 'the new agent' : 'this agent';
    const action = input.operation === 'create' ? 'creating it' : 'updating it';
    const otherMemory = otherReserveMb > 0 ? `, ${gb(otherReserveMb)} for running agents and containers` : '';
    const stop = stopAgent ? `stop "${stopAgent.name || stopAgent.agentId}" (frees ${gb(stopAgent.reservedMb)})` : 'stop running agents';
    const dockerSetting = input.dockerDesktop ? ' (Docker Desktop: Settings → Resources → Memory)' : ' of memory';
    const error = `Not enough memory for ${agent}. Docker has ${gb(input.dockerTotalMb)}; ${action} needs ${gb(requiredMb)}: ${gb(targetReserveMb)} for ${agent} (OpenClaw ${input.version})${otherMemory}, ${gb(HEADROOM_MB)} kept free. To continue, ${stop} or give Docker at least ${dockerMemoryGb} GB${dockerSetting}. Nothing was changed.`;
    return { ...fail('insufficient-host', error), breakdown };
  }
  return { ok: true, targetReserveMb, otherReserveMb, requiredMb, dockerTotalMb: input.dockerTotalMb, breakdown };
}

module.exports = { HEADROOM_MB, gb, resourcePolicyFor, memoryLimitPolicyError, evaluateAgentResources };
