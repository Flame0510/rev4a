/**
 * Client-side UI copy for the subscription providers, keyed by provider id.
 *
 * The registry (`lib/subscription-providers.ts`) stays free of UI text; this map holds every
 * string that names the provider, so adding a provider means adding one entry here. The page,
 * `AgentRow` and `ConnectModal` read their words from here instead of hard-coding them.
 */
import type { SubscriptionProviderId } from '@/lib/subscription-providers';

export interface SubscriptionProviderCopy {
  /** Shown when the model list stays empty after Connect. */
  modelsUnavailable: string;
  /** The pill shown while the catalogue is loading after Connect. */
  modelsLoading: string;
  /** The sentence after the pill while the catalogue is loading. */
  modelsPending: string;
  /** The note under the agent rows about the shared quota. */
  usageShared: string;
  /** The label used for a signed-in account whose email is unknown. */
  accountLabel: string;
  /** The dialog title: "Connect <provider> to <agent>". */
  connectTitle: (agentName: string) => string;
  /** The instruction under the device code. */
  codeHint: string;
  /** The line under the device code while the login waits. */
  waiting: string;
  /** The disconnect confirmation: "<agent> goes back to <model> and signs out of <provider>". */
  disconnectMessage: (agentName: string, backTo: string) => string;
}

const CHATGPT: SubscriptionProviderCopy = {
  modelsUnavailable: 'ChatGPT models are still unavailable. Refresh to try again.',
  modelsLoading: 'Loading ChatGPT models…',
  modelsPending: 'The agent is loading the ChatGPT catalogue after Connect; this takes about a minute.',
  usageShared: 'The limit is shared with your own use of Codex on the same account.',
  accountLabel: 'ChatGPT account',
  connectTitle: (agentName) => `Connect ChatGPT to ${agentName}`,
  codeHint: 'Enter this code on OpenAI with your ChatGPT account. It expires in 15 minutes.',
  waiting: 'Waiting for you to finish on OpenAI…',
  disconnectMessage: (agentName, backTo) => `Disconnect ${agentName}? It goes back to ${backTo} and signs out of ChatGPT. Connecting again needs a new code.`,
};

export const SUBSCRIPTION_PROVIDER_COPY: Readonly<Record<SubscriptionProviderId, SubscriptionProviderCopy>> = {
  openai: CHATGPT,
};

/** The copy for a provider id, or null for anything this build does not know. */
export function getProviderCopy(id: unknown): SubscriptionProviderCopy | null {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PROVIDER_COPY, id)) return null;
  return SUBSCRIPTION_PROVIDER_COPY[id as SubscriptionProviderId];
}
