export const HEADROOM_MB: number;
export interface ResourcePolicy { known: boolean; reserveMb: number; minimumLimitMb: number | null; advice: string }
export interface ResourceContainer { agentId: string | null; limitMb: number | null; usageMb: number | null }
export interface ResourceReservation { agentId: string; reservedMb: number }
export interface ResourceAdmissionInput {
  version: string | null | undefined;
  operation: 'create' | 'update';
  targetAgentId: string;
  limitMb: number | null;
  targetUsageMb?: number | null;
  dockerTotalMb: number | null;
  containers: ResourceContainer[];
  reservations?: ResourceReservation[];
}
export type ResourceAdmission =
  | { ok: true; targetReserveMb: number; otherReserveMb: number; requiredMb: number; dockerTotalMb: number }
  | { ok: false; code: string; error: string };
export function resourcePolicyFor(version?: string | null): ResourcePolicy;
export function memoryLimitPolicyError(version: string | null | undefined, limitMb: number | null): string;
export function evaluateAgentResources(input: ResourceAdmissionInput): ResourceAdmission;
