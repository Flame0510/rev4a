export const RUNTIME_ONLY_ENV_KEYS: readonly string[];
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
/** One-line assignments only; automatic line edits refuse anything else. */
export function isPlainEnvFile(content: string): boolean;
