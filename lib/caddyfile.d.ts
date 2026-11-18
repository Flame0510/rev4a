import type { DomainConfig } from './domain.js';

interface Token {
  value: string;
  start: number;
  end: number;
  brace?: boolean;
}
interface Block {
  header: Token[];
  open: Token;
  close: Token;
  body: Token[];
}
export function scanCaddyfile(text: string, options?: { requireBlocks?: boolean }): { blocks: Block[]; imports: string[] };
export function onDemandOptions(text: string, global?: Block): { start: Token; ask?: Token; permission?: boolean } | undefined;
export function hasCaddyImport(imports: string[], config: DomainConfig): boolean;
