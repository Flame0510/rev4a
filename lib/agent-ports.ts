/**
 * Host-port helpers shared by agent creation and the edit (rename/ports) flow, so both
 * validate a range the same way and produce the same error messages. Pure functions only:
 * this module is imported by client components too. The Docker lookup lives in
 * `lib/agent-ports-server.ts`.
 *
 * The mapping convention is one block starting at the container's gateway port 3000:
 * `3700` publishes `3700:3000`, and `3700-3709` publishes `3700-3709:3000-3009`.
 * OpenClaw shifts its derived ports (browser, canvas) from 3000, which is why agents are
 * created with a block rather than a single mapping.
 */

/** Rev4a's own port: never offer it to an agent. */
export const REV4A_PORT = 3740;
/** Agents publish this many consecutive host ports by default. */
export const DEFAULT_BLOCK_SIZE = 10;

/** An available host block, from 3700 up, skipping Rev4a's port. */
export function findAvailablePortBlock(usedPorts: ReadonlySet<number> = new Set(), blockSize = DEFAULT_BLOCK_SIZE): number {
  for (let base = 3700; base + blockSize - 1 <= 3799; base += DEFAULT_BLOCK_SIZE) {
    if (base <= REV4A_PORT && REV4A_PORT <= base + blockSize - 1) continue;
    const block = Array.from({ length: blockSize }, (_, i) => base + i);
    if (block.every((p) => !usedPorts.has(p))) return base;
  }
  let base = 3800;
  while (true) {
    const block = Array.from({ length: blockSize }, (_, i) => base + i);
    if (block.every((p) => !usedPorts.has(p))) return base;
    base += DEFAULT_BLOCK_SIZE;
  }
}

export type PortInputResult =
  | { valid: true; isBlock: boolean; start: number; end: number }
  | { valid: false; error: string };

/**
 * Validate `"3700"` or `"3700-3709"` against the ports already published (pass
 * `getUsedHostPorts()` on the server; the client passes what it was given).
 */
export function validatePortInput(input: string, usedPorts: ReadonlySet<number> = new Set()): PortInputResult {
  const trimmed = input.trim();
  if (trimmed.includes('-')) {
    const m = trimmed.match(/^(\d{1,5})-(\d{1,5})$/);
    if (!m) return { valid: false, error: 'Invalid format. Use e.g. 3700-3709' };
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start < 1 || end > 65535) return { valid: false, error: 'Ports must be between 1 and 65535' };
    if (end <= start) return { valid: false, error: 'End port must be greater than start port' };
    if (start <= REV4A_PORT && REV4A_PORT <= end) return { valid: false, error: `Port ${REV4A_PORT} is reserved for Rev4a` };
    const conflicts: number[] = [];
    for (let p = start; p <= end; p++) { if (usedPorts.has(p)) conflicts.push(p); }
    if (conflicts.length > 0) return { valid: false, error: `Ports already in use: ${conflicts.join(', ')}` };
    return { valid: true, isBlock: true, start, end };
  }
  const m = trimmed.match(/^(\d{1,5})$/);
  if (!m) return { valid: false, error: 'Use a number (e.g. 3700) or a range (e.g. 3700-3709)' };
  const port = parseInt(m[1], 10);
  if (port < 1 || port > 65535) return { valid: false, error: 'Port must be between 1 and 65535' };
  if (port === REV4A_PORT) return { valid: false, error: `Port ${REV4A_PORT} is reserved for Rev4a` };
  if (usedPorts.has(port)) return { valid: false, error: `Port ${port} is already in use` };
  return { valid: true, isBlock: false, start: port, end: port };
}

/** `-p` host prefix: `127.0.0.1:`, `[::1]:`, or nothing (every interface). */
export function hostIpPrefix(hostIp?: string | null): string {
  const ip = (hostIp ?? '').trim();
  if (!ip || ip === '0.0.0.0' || ip === '::') return '';
  return ip.includes(':') ? `[${ip.replace(/^\[(.*)\]$/, '$1')}]:` : `${ip}:`;
}

/**
 * `docker run` port arguments for a validated range, mapping onto the container 3000.
 * `hostIp` (REV4A_AGENT_PORTS_LISTEN) limits the publish to one host address; null/undefined
 * publishes on every interface, as before.
 */
export function portMappingArgs(start: number, end: number, hostIp?: string | null): string[] {
  const prefix = hostIpPrefix(hostIp);
  return ['-p', end === start ? `${prefix}${start}:3000` : `${prefix}${start}-${end}:3000-${3000 + (end - start)}`];
}

export type PortBindings = Record<string, { HostIp?: string; HostPort?: string }[] | null> | null | undefined;

/** Only running agents are offered Recreate and only stopped agents are asked on Start or Restart. */
export function agentPortContainerState(state?: { Status?: string; Running?: boolean }): 'running' | 'stopped' | null {
  if (state?.Running === true || state?.Status === 'running' || state?.Status === 'paused') return 'running';
  if (state?.Status === 'exited' || state?.Status === 'created' || state?.Status === 'dead') return 'stopped';
  return null;
}

/**
 * `-p` arguments that recreate a container's current publishes (`HostConfig.PortBindings`).
 * Each binding keeps its own HostIp, unless `overrideHostIp` is given: then every binding
 * moves to that address (the REV4A_AGENT_PORTS_LISTEN setting wins over the old one).
 */
export function portArgsFromBindings(bindings: PortBindings, overrideHostIp?: string | null): string[] {
  return Object.entries(bindings ?? {}).flatMap(([containerPort, list]) => {
    const proto = containerPort.includes('/udp') ? '/udp' : '';
    // Docker can report both wildcard families for one publish; retain it only once.
    const mappings = new Set<string>();
    for (const binding of list ?? []) {
      if (!binding.HostPort) continue;
      const prefix = hostIpPrefix(overrideHostIp ?? binding.HostIp);
      mappings.add(`${prefix}${binding.HostPort}:${containerPort.replace(/\/.*$/, '')}${proto}`);
    }
    return [...mappings].flatMap((mapping) => ['-p', mapping]);
  });
}

/**
 * True when a container publishes on an address that is wider than the setting says: with
 * `hostIp` null (`all`) nothing is wider; otherwise every binding must be on exactly `hostIp`.
 */
export function publishesWiderThan(bindings: PortBindings, hostIp: string | null): boolean {
  if (!hostIp) return false;
  const want = hostIp.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return Object.values(bindings ?? {}).some((list) => (list ?? []).some((b) => {
    if (!b?.HostPort) return false;
    return (b.HostIp ?? '').trim().replace(/^\[(.*)\]$/, '$1').toLowerCase() !== want;
  }));
}

/** Any mismatch, including a loopback binding when the operator explicitly selects all. */
export function publishesDifferently(bindings: PortBindings, hostIp: string | null): boolean {
  if (hostIp === null) return false; // unset keeps each agent's address
  if (hostIp) return publishesWiderThan(bindings, hostIp);
  return Object.values(bindings ?? {}).some((list) => (list ?? []).some((binding) =>
    !!binding.HostPort && !['', '0.0.0.0', '::', '[::]'].includes((binding.HostIp ?? '').trim())));
}

/** The host ports a container publishes, from its inspect (`HostConfig.PortBindings`). */
export function hostPortsFromBindings(container: {
  HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}): number[] {
  return Object.values(container.HostConfig?.PortBindings ?? {})
    .flatMap((bindings) => bindings ?? [])
    .map((b) => Number(b?.HostPort))
    .filter((n) => Number.isInteger(n));
}

/** Published host ports, optionally limited to TCP mappings for one container port. */
export function hostPortsFromArgs(portArgs: readonly string[], tcpContainerPort?: number): number[] {
  const ports: number[] = [];
  for (let i = 0; i < portArgs.length - 1; i++) {
    if (portArgs[i] !== '-p') continue;
    // The final pair is hostPort:containerPort, including an optional IPv4 or [IPv6] prefix.
    const parts = portArgs[i + 1].split(':');
    const host = parts.at(-2) ?? '';
    const [start, end] = host.split('-').map(Number);
    if (!Number.isInteger(start)) continue;
    const last = Number.isInteger(end) ? end : start;
    if (tcpContainerPort === undefined) {
      for (let p = start; p <= last; p++) ports.push(p);
    } else {
      const [range, protocol = 'tcp'] = (parts.at(-1) ?? '').split('/');
      const [first, lastContainerPort = first] = range.split('-').map(Number);
      const mapped = start + tcpContainerPort - first;
      if (protocol === 'tcp' && tcpContainerPort >= first && tcpContainerPort <= lastContainerPort && mapped <= last) ports.push(mapped);
    }
  }
  return ports;
}
