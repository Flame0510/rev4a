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
