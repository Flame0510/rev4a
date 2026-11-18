import type { lstat, readFile } from 'node:fs/promises';
import type { DomainConfig, DomainEnv, DomainRouteCheck } from './domain.js';

export interface CaddySyncResult {
  ok: boolean;
  changed: boolean;
  routes?: number;
  error?: string;
}
export function syncCaddy(options: { env?: DomainEnv; dataDir: string; forgetContainer?: string }): Promise<CaddySyncResult>;
export function checkAgentRoute(route: DomainRouteCheck): Promise<boolean>;
interface CaddyReader {
  lstat: typeof lstat;
  readFile: typeof readFile;
}
type RunCaddy = (file: string, args: string[], options?: { input?: string; timeout?: number }) => Promise<string>;
export function caddyDependencies(overrides?: Partial<{ io: CaddyReader; run: RunCaddy }>): { io: CaddyReader; run: RunCaddy };
export function caddyAvailable(run: RunCaddy): Promise<boolean>;
export function caddyMain(io: CaddyReader, config: DomainConfig): Promise<{ imports: string[]; askUrl?: string; permission: boolean }>;
export function readDomainSettings(env: DomainEnv, dataDir: string, io: CaddyReader): Promise<{ settings: DomainEnv; saved: DomainEnv }>;
export function readSnapshot(io: CaddyReader, file: string): Promise<{ text: string; mode: number; uid: number; gid: number } | null>;
export function readDomainCredential(dataDir: string, io?: CaddyReader): Promise<{ user: string; password: string } | null>;
