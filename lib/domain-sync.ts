import { syncCaddy } from './caddy';
import { REV4A_DATA } from './rev4a-paths';

/** Dashboard-side entry point. The daemon and CLI already know their data directory. */
export function syncDomainRoutes(forgetContainer?: string) {
  return syncCaddy({ dataDir: REV4A_DATA, forgetContainer });
}
