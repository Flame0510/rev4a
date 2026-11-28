export const HEADROOM_MB: number;
export function gb(mb: number, withUnit?: boolean): string;
export interface ResourcePolicy { known: boolean; reserveMb: number; minimumLimitMb: number | null; advice: string }
export interface ResourceContainer { agentId: string | null; name?: string | null; limitMb: number | null; usageMb: number | null }
export interface ResourceReservation { agentId: string; reservedMb: number }
export interface ResourceAdmissionInput {
  version: string | null | undefined;
  operation: 'create' | 'update';
  targetAgentId: string;
  limitMb: number | null;
  targetUsageMb?: number | null;
  dockerTotalMb: number | null;
  dockerDesktop?: boolean;
  containers: ResourceContainer[];
  reservations?: ResourceReservation[];
}
export interface ResourceBreakdown {
  dockerTotalMb: number;
  requiredMb: number;
  shortfallMb: number;
  headroomMb: number;
  target: { reserveMb: number; basis: 'limit' | 'policy' | 'usage' };
  others: {
    agentId: string | null;
    name: string | null;
    reservedMb: number;
    basis: 'limit' | 'usage' | 'claim';
    kind: 'agent' | 'container';
    /** This running agent also has an in-flight reservation. */
    claimed?: true;
  }[];
  suggestion: {
    stopAgentId: string | null;
    stopAgentName: string | null;
    freesMb: number | null;
    dockerMemoryGb: number;
  };
}
export interface ResourceRefusal { ok: false; code: string; error: string; breakdown?: ResourceBreakdown }
export type ResourceAdmission =
  | { ok: true; targetReserveMb: number; otherReserveMb: number; requiredMb: number; dockerTotalMb: number; breakdown: ResourceBreakdown }
  | ResourceRefusal;
export function resourcePolicyFor(version?: string | null): ResourcePolicy;
export function memoryLimitPolicyError(version: string | null | undefined, limitMb: number | null): string;
export function evaluateAgentResources(input: ResourceAdmissionInput): ResourceAdmission;
