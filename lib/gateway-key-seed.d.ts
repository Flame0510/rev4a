export function seedGatewayKey(
  file: string,
  env?: NodeJS.ProcessEnv,
  log?: (message: string) => void,
): 'exists' | 'created-file' | 'added' | 'skipped-unreadable' | 'skipped-error' | 'skipped-changed';
