export const CLAUDE_SETTINGS_PATH: '/root/.claude/settings.json';
export type EnsureSandboxEnvResult = 'ok' | 'set' | 'invalid';
/** Self-contained ES2019 source shared by the pure helper and the container script. */
export const ENSURE_SANDBOX_ENV_SRC: string;
/** `text`: the current settings.json content, or null when the file does not exist. Returned `text` is set only for 'set'. */
export function ensureSandboxEnv(text: string | null): { result: EnsureSandboxEnvResult; text: string | null };
/** Fixed `node -e` source run in the agent container; prints one JSON line. */
export const ENSURE_SANDBOX_ENV_SCRIPT: string;
/** null when the output is not the script's one JSON line. */
export function parseEnsureSandboxResult(stdout: string): EnsureSandboxEnvResult | 'error' | null;
