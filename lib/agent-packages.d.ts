/** Types for the CommonJS system-packages helpers shared with daemon.js. */

export type PackagesState = 'running' | 'ok' | 'partial' | 'failed' | 'nothing-to-do';

export interface PackagesStatus {
  /** When the restore wrote the file, in ms. */
  at: number;
  state: PackagesState;
  restored: string[];
  versionChanged: string[];
  failed: { name: string; error: string }[];
}

export interface PackageEntry {
  name: string;
  version: string;
}

export const STATES: PackagesState[];
export const MAX_TEXT_CHARS: number;
export const MAX_STATUS_ENTRIES: number;
export const MAX_PACKAGES: number;

/** Normalised packages-status.json, or null when unreadable or of an unknown state. */
export function parseStatus(text: unknown): PackagesStatus | null;
/** `name=version` lines as entries; blank and malformed lines are skipped. */
export function parsePackageList(text: unknown): PackageEntry[];
/** The failed entries without the run's own `*` pseudo-entry, and that entry's error (null when absent). */
export function splitFailed(status: { failed: { name: string; error: string }[] } | null | undefined): { packages: { name: string; error: string }[]; runError: string | null };
/** Alert text for a failed or partial run. */
export function failureMessage(container: string, status: PackagesStatus): string;
/** De-duplication key: the same container and the same `at` are the same restore run. */
export function statusAlertKey(agent: string, status: { at: number } | null | undefined): string;
