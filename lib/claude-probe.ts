/** The same bounded, fixed Claude usage call for connection checks and account usage. No credentials are read. */
import { dockerExec } from '@/lib/docker-exec';
import { CLAUDE_USAGE_PROBE, claudeTermsRequired, parseClaudeUsageEvent, type ClaudeUsageWindow } from '@/lib/subscription-claude-parse';

export type ClaudeProbeResult = { windows: ClaudeUsageWindow[] } | { termsRequired: true } | { failed: true };

export async function runClaudeProbe(container: string): Promise<ClaudeProbeResult> {
  try {
    // The in-container deadline is 60 s; leave the exec itself another 10 s on the host.
    const out = await dockerExec(container, ['sh', '-c', CLAUDE_USAGE_PROBE], { timeoutMs: 70_000 });
    if (claudeTermsRequired(out)) return { termsRequired: true };
    const windows = parseClaudeUsageEvent(out);
    return windows ? { windows } : { failed: true };
  } catch {
    return { failed: true };
  }
}
