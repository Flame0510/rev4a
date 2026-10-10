/**
 * Defaults for new agents, kept in REV4A_DATA/agent-defaults.json
 * (`{ "memoryLimitMb": number | null }`). They only prefill the create wizard: nothing
 * here is ever applied to an agent that exists. The file is optional; a missing,
 * unreadable or invalid one reads as "no default" and never throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { parseLimitMb } from '@/lib/agent-memory-limit';

export interface AgentDefaults {
  /** Prefill for the create wizard's memory limit; null means none. */
  memoryLimitMb: number | null;
}

function defaultsPath(): string {
  return path.join(REV4A_DATA, 'agent-defaults.json');
}

export function readAgentDefaults(): AgentDefaults {
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath(), 'utf-8')) as { memoryLimitMb?: unknown };
    return { memoryLimitMb: parseLimitMb(raw?.memoryLimitMb) };
  } catch {
    return { memoryLimitMb: null };
  }
}

/** Written through a temp file and a rename, mode 0600. `memoryLimitMb` is already validated. */
export function writeAgentDefaults(defaults: AgentDefaults): void {
  const file = defaultsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ memoryLimitMb: defaults.memoryLimitMb }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}
