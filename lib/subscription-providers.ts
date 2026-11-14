/**
 * The subscription providers Rev4a knows, in one registry shared by the Subscriptions page,
 * its components and the read routes.
 *
 * A provider entry says how Rev4a talks to one provider: the id the API uses, the name and
 * short name, the prefix of its model ids, its login and logout routes, whether it has usage
 * limits to show, and whether it is still experimental. It carries no UI text (that lives in
 * `app/subscriptions/providers.ts`) and no Node or server imports, because the page imports
 * this module too.
 *
 * Two entries: ChatGPT (Codex) and Claude (via Claude Code), both with a server implementation,
 * so the Subscriptions page shows one accordion each. `loginKind` tells the page which dialog body
 * to build (the ChatGPT device code or Anthropic's link plus pasted code); the page never picks a
 * dialog from the provider id.
 */

export type SubscriptionProviderId = 'openai' | 'anthropic';

/**
 * How the provider's sign-in dialog works. `device-code`: Rev4a shows a link and a code the
 * operator enters on the provider's site. `link-code`: the operator signs in on the provider's
 * own page and pastes back the code it shows.
 */
export type SubscriptionLoginKind = 'device-code' | 'link-code';

export interface SubscriptionProvider {
  /** The id the API uses and the `provider` query parameter takes. */
  readonly id: SubscriptionProviderId;
  /** The name shown as the accordion title, e.g. "ChatGPT (Codex)". */
  readonly name: string;
  /** The short name used in sentences, e.g. "ChatGPT". */
  readonly shortName: string;
  /** The prefix of this provider's model ids, e.g. "openai/". */
  readonly modelPrefix: string;
  /** The route that starts, reads and cancels a login. */
  readonly loginPath: string;
  /** The route that starts and reads a disconnect job. */
  readonly logoutPath: string;
  /** How the sign-in dialog works; the page chooses the dialog body by this, never by id. */
  readonly loginKind: SubscriptionLoginKind;
  /** Whether the provider has usage limits (the usage block and route). */
  readonly hasUsage: boolean;
  /**
   * Whether the provider is still experimental: its flow is verified but not offered everywhere
   * yet. The page still renders it, with an "Experimental" pill on its accordion.
   */
  readonly experimental: boolean;
}

const OPENAI: SubscriptionProvider = Object.freeze({
  id: 'openai',
  name: 'ChatGPT (Codex)',
  shortName: 'ChatGPT',
  modelPrefix: 'openai/',
  loginPath: '/api/subscriptions/openai/login',
  logoutPath: '/api/subscriptions/openai/logout',
  loginKind: 'device-code',
  hasUsage: true,
  experimental: false,
});

const ANTHROPIC: SubscriptionProvider = Object.freeze({
  id: 'anthropic',
  name: 'Claude (via Claude Code)',
  shortName: 'Claude',
  modelPrefix: 'anthropic/',
  loginPath: '/api/subscriptions/anthropic/login',
  logoutPath: '/api/subscriptions/anthropic/logout',
  loginKind: 'link-code',
  hasUsage: true,
  experimental: true,
});

/** Every provider this client and server know, in display order. */
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = Object.freeze([OPENAI, ANTHROPIC]);

/** The provider used when a request does not name one. */
export const DEFAULT_SUBSCRIPTION_PROVIDER: SubscriptionProvider = OPENAI;

const BY_ID: ReadonlyMap<string, SubscriptionProvider> = new Map(SUBSCRIPTION_PROVIDERS.map((p) => [p.id, p]));

/** The descriptor for an id, or null for anything this build does not know (never a prototype key). */
export function getSubscriptionProvider(id: unknown): SubscriptionProvider | null {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id) ?? null;
}

/**
 * The provider named by the optional `provider` query parameter: missing or empty is the
 * default provider, so every existing caller keeps working; a known id is its descriptor;
 * anything else is null (the route answers 400).
 */
export function providerFromParam(value: string | null): SubscriptionProvider | null {
  if (value === null || value === '') return DEFAULT_SUBSCRIPTION_PROVIDER;
  return getSubscriptionProvider(value);
}
