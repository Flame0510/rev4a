export function resolveCreateModel(
  body: { model?: unknown; noModel?: unknown },
  isOffered: (id: string) => boolean,
  defaultModel: string,
): { kind: 'model'; model: string } | { kind: 'none' } | { kind: 'error'; status: 400; error: string } {
  if ('noModel' in body && typeof body.noModel !== 'boolean') {
    return { kind: 'error', status: 400, error: 'noModel must be a boolean' };
  }
  if (body.noModel === true) {
    if (body.model !== undefined && body.model !== '') {
      return { kind: 'error', status: 400, error: 'Send either model or noModel, not both' };
    }
    return { kind: 'none' };
  }

  const model = typeof body.model === 'string' && body.model ? body.model : defaultModel;
  if (!isOffered(model)) {
    return {
      kind: 'error',
      status: 400,
      error: `Model '${model}' is not offered by this deployment: it is not in the catalogue, is disabled, or its provider has no API key.`,
    };
  }
  return { kind: 'model', model };
}

export const SUBSCRIPTION_MODEL_PREFERENCES = {
  openai: (key: string) => key === 'openai/gpt-6.1-sol',
  anthropic: (key: string) => key.includes('sonnet'),
} as const;

export function pickSubscriptionModel(
  provider: keyof typeof SUBSCRIPTION_MODEL_PREFERENCES,
  models: { key: string }[],
): string | null {
  const matching = models.filter(({ key }) => key.startsWith(`${provider}/`));
  return (matching.find(({ key }) => SUBSCRIPTION_MODEL_PREFERENCES[provider](key)) ?? matching[0])?.key ?? null;
}

export function needsModelSetup(row: { health?: string } | undefined | null): boolean {
  return row?.health === 'unset';
}
