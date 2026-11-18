import type { DomainConfig, DomainEnv } from './domain.js';

export function planCaddyfile(text: string, config: DomainConfig): { content: string; actions: string[] };
export function planDomainEnvironment(text: string, domain: string, inherited: DomainEnv): { content: string; updated: string[] };
export function setupDomain(options: { args: string[]; dataDir: string; env?: DomainEnv }): Promise<{ changed: boolean }>;
