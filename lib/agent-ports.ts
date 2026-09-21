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

/** `docker run` port arguments for a validated range, mapping onto the container 3000. */
export function portMappingArgs(start: number, end: number): string[] {
  return ['-p', end === start ? `${start}:3000` : `${start}-${end}:3000-${3000 + (end - start)}`];
}
