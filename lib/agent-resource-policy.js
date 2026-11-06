'use strict';

/** Shared resource guidance/admission arithmetic. Pure: no Docker, files, clocks or defaults. */
const HEADROOM_MB = 1024;
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const usage = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const gb = (mb) => `${Number((mb / 1024).toFixed(2))} GB`;

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
  const claims = new Map();
  for (const claim of input.reservations ?? []) {
    if (!claim || typeof claim.agentId !== 'string' || !positive(claim.reservedMb)) return fail('unknown-reservation', 'An in-flight agent resource reservation is unreadable. Retry after the operation ends.');
    claims.set(claim.agentId, Math.max(claims.get(claim.agentId) ?? 0, claim.reservedMb));
  }
  claims.delete(input.targetAgentId);
  let otherReserveMb = 0;
  for (const container of input.containers ?? []) {
    if (container.agentId === input.targetAgentId) continue;
    let reserved;
    if (container.agentId) {
      if (container.limitMb !== null && !positive(container.limitMb)) return fail('unknown-limit', 'Another running agent has an unreadable memory limit. Retry once Docker can inspect every running agent.');
      if (container.limitMb !== null) reserved = container.limitMb;
      else if (usage(container.usageMb)) reserved = container.usageMb + HEADROOM_MB;
      else return fail('unknown-usage', 'Memory usage of another unlimited agent could not be read. Stop it or retry once Docker statistics are available.');
    } else if (usage(container.usageMb)) reserved = container.usageMb;
    else if (positive(container.limitMb)) reserved = container.limitMb;
    else return fail('unknown-usage', 'Memory usage of another running container could not be read. Retry once Docker statistics are available.');
    if (container.agentId && claims.has(container.agentId)) {
      reserved = Math.max(reserved, claims.get(container.agentId));
      claims.delete(container.agentId);
    }
    otherReserveMb += reserved;
  }
  for (const reserved of claims.values()) otherReserveMb += reserved;
  const requiredMb = targetReserveMb + otherReserveMb + HEADROOM_MB;
  if (requiredMb > input.dockerTotalMb) {
    return fail('insufficient-host', `Docker has ${gb(input.dockerTotalMb)} memory; this operation needs ${gb(requiredMb)} of planning headroom, including running agents and containers. Stop other agents or increase Docker memory, then retry. Existing limits have not been changed.`);
  }
  return { ok: true, targetReserveMb, otherReserveMb, requiredMb, dockerTotalMb: input.dockerTotalMb };
}

module.exports = { HEADROOM_MB, resourcePolicyFor, memoryLimitPolicyError, evaluateAgentResources };
