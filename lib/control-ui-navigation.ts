/** Fixed native destinations only. Callers cannot choose a host, scheme or arbitrary redirect. */
import { isValidCronJobId } from './cron-ids';

/** Same public ID shape as lib/container.ts, without importing its server-only child_process code. */
export const isControlUiAgentId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);

/** No job preserves the exact existing link, including its authentication fragment. */
export function controlUiAutomationUrl(baseUrl: string, jobId?: string | null): string {
  if (jobId == null) return baseUrl;
  if (!isValidCronJobId(jobId)) throw new Error('Invalid automation job id');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid Control UI link'); }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/automations`;
  url.searchParams.set('job', jobId);
  return url.toString();
}

/** Navigate through Rev4a so native one-time/browser authentication remains server-side. */
export function controlUiOpenPath(agentId: string, jobId?: string): string {
  const path = `/api/agents/${encodeURIComponent(agentId)}/open-control-ui`;
  if (jobId === undefined) return path;
  if (!isValidCronJobId(jobId)) throw new Error('Invalid automation job id');
  return `${path}?${new URLSearchParams({ job: jobId }).toString()}`;
}

/** Only the reproduced ownership refusal, not an arbitrary billing/login/delivery error. */
export function isMissingInferenceAccountError(error: unknown): boolean {
  return typeof error === 'string'
    && /^(?:Error: )?Automation has no recorded inference account\.(?:\s|$)/.test(error.trim());
}

/** Only the evaluated source-to-target upgrade needs this migration notice. */
export function needsInferenceAccountAdoptionNotice(fromVersion: unknown, toVersion: unknown): boolean {
  return (fromVersion === '2026.9.3' || fromVersion === '2026.9.9') && toVersion === '2026.10.10';
}
