// Pure checks for the cron routes: a job id and the agent container a request names.
// No imports on purpose, so the rules can be tested without the Next.js path aliases.

/** A cron job id: no leading dash (the id is an argument of the OpenClaw CLI), 128 characters at most. Same rule as lib/agent-sessions.js. */
export const CRON_JOB_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export function isValidCronJobId(v: unknown): v is string {
  return typeof v === 'string' && CRON_JOB_ID_RE.test(v);
}

export type CronRequestCheck = { ok: true } | { ok: false; status: 400 | 502; error: string };

/**
 * Checks the job id and the container of a cron request before anything is executed: the id by shape,
 * the container by shape and by being one of the agent containers Docker lists.
 * `listContainers` throws when Docker cannot answer.
 */
export async function checkCronRequest(
  input: { jobId: unknown; containerName: unknown },
  deps: { isValidContainer: (v: unknown) => boolean; listContainers: () => Promise<Array<{ container: string }>> },
): Promise<CronRequestCheck> {
  if (!isValidCronJobId(input.jobId)) return { ok: false, status: 400, error: 'Invalid job id' };
  if (!deps.isValidContainer(input.containerName)) return { ok: false, status: 400, error: 'Unknown agent' };
  let known: Array<{ container: string }>;
  try {
    known = await deps.listContainers();
  } catch {
    return { ok: false, status: 502, error: 'Docker is not reachable' };
  }
  if (!known.some((c) => c.container === input.containerName)) return { ok: false, status: 400, error: 'Unknown agent' };
  return { ok: true };
}
