export const RUNTIME_ONLY_ENV_KEYS: readonly string[];
/** Physical lines, including their original CRLF, CR or LF separators. */
export function splitEnvLines(content: string): string[];
/** Dotenv syntax, last assignment wins; no process-env merge or $ expansion. */
export function parseEnvValues(content: string): Record<string, string>;
/** Undefined when absent; '' when explicitly empty. */
export function readEnvValue(content: string, key: string): string | undefined;
export interface EnvFileLine {
  text: string;
  continuation: boolean;
  endIndex: number;
  key?: string;
  value?: string;
}
export function classifyEnvLines(content: string): EnvFileLine[];
export function removeRuntimeEnvLines(content: string): { content: string; removed: string[]; skipped?: boolean };
/** Throws TypeError for an invalid new assignment key. */
export function assertEnvKey(key: string): void;
/** Throws TypeError for a non-string / multiline / NUL value; permits legacy keys. */
export function assertEnvValue(key: string, value: unknown): asserts value is string;
export function isLoaderEnvKey(key: string): boolean;
export function stripUninheritedLoaderEnv(
  env: Record<string, string | undefined>,
  inheritedKeys: ReadonlySet<string>,
  warn: (message: string) => void,
): void;
export function disableLoaderEnvLines(content: string): { content: string; disabled: string[] };
/** One-line assignments without ambiguous quotes; automatic line edits refuse anything else. */
export function isPlainEnvFile(content: string): boolean;
/** Text after KEY= that every reader reads back as `value`; throws code UNSAFE_ENV_VALUE otherwise. */
export function serializeEnvValue(key: string, value: string): string;
/** Edits on a plain .env (codes NOT_PLAIN_ENV / UNSAFE_ENV_VALUE on refusal). */
export function applyEnvEdits(
  content: string, edits: Array<[string, string | undefined]>, options?: { keepEmpty?: boolean },
): { content: string; updated: string[] };
export function unquoteEnvValue(raw: string): string;
export function hasEnvAssignment(content: string, key: string): boolean;
