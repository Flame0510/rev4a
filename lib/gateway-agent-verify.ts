interface StoredModel {
  primary?: unknown;
  fallbacks?: unknown;
}

interface StoredAgentConfig {
  agents?: {
    defaults?: { model?: StoredModel };
    list?: { id?: unknown; model?: StoredModel }[];
  };
}

/** Check the model fields written by PUT against a fresh read of openclaw.json. */
export function modelWriteVerified(
  raw: string,
  expected: { primary: string; fallbacks: string[]; mainPrimary?: string },
): boolean {
  let config: StoredAgentConfig | null;
  try {
    config = JSON.parse(raw);
  } catch {
    return false;
  }

  const agents = config?.agents;
  const model = agents?.defaults?.model;
  if (model?.primary !== expected.primary) return false;
  // An empty list may be dropped by a later rewrite of the file: missing reads as [].
  const fallbacks = model.fallbacks === undefined ? [] : model.fallbacks;
  if (!Array.isArray(fallbacks) || fallbacks.length !== expected.fallbacks.length
    || !fallbacks.every((fallback, index) => fallback === expected.fallbacks[index])) return false;

  if (expected.mainPrimary === undefined) return true;
  const main = Array.isArray(agents?.list) ? agents.list.find((entry) => entry?.id === 'main') : undefined;
  return main?.model?.primary === expected.mainPrimary;
}
