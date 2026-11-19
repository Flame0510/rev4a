export const ASK_PATH: '/api/domain/ask';
export const DEV_USER: 'rev4a';
export const BCRYPT: RegExp;
export const RELOAD_UNCONFIRMED: string;
export type DomainEnv = Readonly<Record<string, string | undefined>>;
export interface DomainConfig {
  domain: string;
  file: string;
  main: string;
  port: number;
  askUrl: string;
}
type Bindings = Record<string, readonly { HostIp?: string; HostPort?: string }[] | null>;
export interface DomainAgent {
  id?: string;
  agentId?: string;
  containerName: string;
  displayName?: string;
  created?: string;
  running?: boolean;
  activeBindings?: Bindings;
}
export interface DomainAssignment {
  base: string;
  name: string;
  id?: string;
}
export interface DomainNameTable {
  assignments: Map<string, DomainAssignment>;
  retired?: ReadonlySet<string>;
  routes: { name: string; hostPort: number; dev: boolean; displayName?: string }[];
}
export function isGenerated(content: string): boolean;
export { normalizeDomain } from './domain-name.js';
export function domainConfig(env: DomainEnv): DomainConfig | null;
export function parsePort(value: string | undefined): number | null;
export function agentBase(agent: DomainAgent): string;
export function agentHostPort(agent: DomainAgent, containerPort: number): number | null;
export interface DomainAgentState {
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
}
export function canRouteAgent(state?: DomainAgentState): boolean;
export function buildNameTable(
  agents: readonly DomainAgent[], previous?: ReadonlyMap<string, DomainAssignment>, dashboardPort?: number, retired?: ReadonlySet<string>,
): DomainNameTable;
export function readAssignments(content: string | null, domain: string): Map<string, DomainAssignment>;
export function readRetiredLabels(content: string | null, domain: string): Set<string>;
export function readManagedRoutes(content: string, domain: string): Map<string, number> | null;
export function readRouteReservations(content: string): {
  routes: Map<string, number>;
  dashboardPort: number | null;
};
export function renderCaddyfile(config: DomainConfig, table: DomainNameTable, hash?: string): string;
export interface DomainRouteCheck {
  container: string;
  base: string;
  containerPort: number;
  hostPort: number;
}
export function domainAsk(
  request: Pick<Request, 'headers' | 'url'>, env: DomainEnv, readFile: (file: string, encoding: 'utf8') => Promise<string>,
  checkAgentRoute: (route: DomainRouteCheck) => Promise<boolean>,
): Promise<200 | 404>;
