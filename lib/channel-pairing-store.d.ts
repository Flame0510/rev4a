export type PairingStoreOperation = 'read' | 'remove' | 'clear';
export interface PairingStoreResult {
  status: 'ok' | 'absent' | 'unsupported' | 'error';
  entries?: string[];
  error?: string;
}
export function buildPairingStoreScript(packageRoot?: string): string;
export const PAIRING_STORE_SCRIPT: string;
export function parsePairingStoreOutput(output: string, op: PairingStoreOperation): PairingStoreResult;
