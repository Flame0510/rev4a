export const ASK_PATH: '/api/domain/ask';
export const DEV_USER: 'rev4a';
export const BCRYPT: RegExp;
export const PENDING: string;
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
  containerName: string;
  displayName?: string;
  created?: string;
  running?: boolean;
  activeBindings?: Bindings;
}
export interface DomainAssignment {
  base: string;
  name: string;
}
export interface DomainNameTable {
  assignments: Map<string, DomainAssignment>;
  routes: { name: string; hostPort: number; dev: boolean }[];
}
export function isGenerated(content: string): boolean;
export function normalizeDomain(value?: string): string;
export function domainConfig(env: DomainEnv): DomainConfig | null;
export function agentBase(agent: DomainAgent): string;
export function agentHostPort(agent: DomainAgent, containerPort: number): number | null;
export function buildNameTable(
  agents: readonly DomainAgent[], previous?: ReadonlyMap<string, DomainAssignment>, dashboardPort?: number,
): DomainNameTable;
export function readAssignments(content: string | null, domain: string): Map<string, DomainAssignment>;
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
