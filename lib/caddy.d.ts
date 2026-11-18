import type { DomainEnv, DomainRouteCheck } from './domain.js';

export interface CaddySyncResult {
  ok: boolean;
  changed: boolean;
  routes?: number;
  error?: string;
}
export function syncCaddy(options: { env?: DomainEnv; dataDir: string; forgetContainer?: string }): Promise<CaddySyncResult>;
export function checkAgentRoute(route: DomainRouteCheck): Promise<boolean>;
