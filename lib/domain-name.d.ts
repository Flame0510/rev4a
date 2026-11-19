export const LABEL: RegExp;
export const DEFAULT_CADDY_MAIN: string;
export const DEFAULT_CADDY_FILE: string;
/** Returns a normalized hostname or an empty string. Throws on invalid input. */
export function normalizeDomain(value?: string): string;
