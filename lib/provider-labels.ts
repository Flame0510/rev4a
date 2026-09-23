/**
 * What the UI calls each provider key the model catalogue uses. One source: the Gateway's
 * provider cards and the details modal both read it, so a provider is never named two ways.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  groq: 'Groq',
  kimi: 'Kimi',
  glm: 'GLM (Z.AI)',
  qwen: 'Qwen',
  rev4a: 'REV4A API KEY',
};

/** The label for a provider key, falling back to the key itself. */
export function providerLabel(key: string): string {
  return PROVIDER_LABELS[key] ?? key;
}
