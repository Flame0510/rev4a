/** Types for the CommonJS cold-backup helper identity shared with daemon.js. */

export const HELPER_PREFIX: string;
export const LABEL_AGENT: string;
export const LABEL_KIND: string;

export function isBackupHelperName(name: unknown): boolean;
export function backupKindLabel(kind: unknown): 'manual' | 'before update' | 'before recreate';
