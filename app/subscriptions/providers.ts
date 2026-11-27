/**
 * Client-side UI copy for the subscription providers, keyed by provider id.
 *
 * The registry (`lib/subscription-providers.ts`) stays free of UI text; this map holds every
 * string that names the provider, so adding a provider means adding one entry here. The page,
 * `AgentRow`, `ConnectModal` and `ClaudeConnectModal` read their words from here instead of
 * hard-coding them.
 */
import type { SubscriptionProviderId } from '@/lib/subscription-providers';

/** The provider-neutral subtitle of the Subscriptions page. */
export const SUBSCRIPTIONS_PAGE_DESCRIPTION =
  'Connect a subscription to your agents. You choose the model in the agent panel.';

/** The pill next to an experimental provider's accordion title. */
export const EXPERIMENTAL_LABEL = 'Experimental';

/** The closing note of the Claude accordion. */
export const CLAUDE_USAGE_NOTE =
  "Usage counts against your own Claude plan. Anthropic's limits assume ordinary individual use; for round-the-clock automation an API key is the safer choice.";

/** The link under the Claude usage note. */
export const CLAUDE_USAGE_LINK = {
  label: 'Anthropic: using your Claude plan',
  href: 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
} as const;

/** The status line and the action labels of one provider's agent rows. */
export interface SubscriptionRowCopy {
  /** Not installed, or signed out. */
  notConnected: string;
  /** Signed in, but the provider's models do not use the sign-in. */
  signedInNotInUse: string;
  /** Signed out while the models still wait for the sign-in. */
  needsReconnect: string;
  connected: string;
  connectedUntil: (date: string) => string;
  stopped: string;
  error: string;
  connect: string;
  reconnect: string;
  disconnect: string;
  /** The Connect button while its dialog is open. */
  connecting: string;
  /** The Disconnect button while the disconnect job runs. */
  disconnecting: string;
}

/** The guided sign-in dialog of a provider whose flow is a link plus a pasted code. */
export interface LinkCodeCopy {
  starting: string;
  installing: string;
  signInStep: string;
  openSignIn: string;
  copyLink: string;
  linkCopied: string;
  copyLinkByHand: string;
  pasteCodeStep: string;
  codeFieldLabel: string;
  continueAction: string;
  checking: string;
  invalidCode: string;
  verifying: string;
  connecting: string;
  connected: string;
  connectedHint: string;
  done: string;
  startAgain: string;
  cancel: string;
  cancelling: string;
  close: string;
  /** The job was lost (the dashboard restarted while the dialog was open). */
  interrupted: string;
  /** A job that ended without a message from the provider. */
  failed: string;
}

export interface SubscriptionProviderCopy {
  /** Shown when the model list stays empty after Connect. */
  modelsUnavailable: string;
  /** The pill shown while the catalogue is loading after Connect. */
  modelsLoading: string;
  /** The sentence after the pill while the catalogue is loading. */
  modelsPending: string;
  /** The note under the agent rows about the shared quota. */
  usageShared: string;
  /** The sentence under the usage bars when a window is full (fallback name and reset time are appended). */
  usageReached: string;
  /** The label used for a signed-in account whose email is unknown. */
  accountLabel: string;
  /** The dialog title: "Connect <provider> to <agent>". */
  connectTitle: (agentName: string) => string;
  /** The instruction under the device code. */
  codeHint: string;
  /** The line under the device code while the login waits. */
  waiting: string;
  /** The disconnect confirmation. A null model means the agent will need model setup. */
  disconnectMessage: (agentName: string, backTo: string | null) => string;
  /** Row wording and actions; present for a provider with a status the page maps itself. */
  row?: SubscriptionRowCopy;
  /** The guided dialog of a `link-code` provider; absent for a `device-code` one. */
  linkCode?: LinkCodeCopy;
}

const disconnectMessage = (agentName: string, backTo: string | null, provider: string) =>
  backTo === null
    ? `Disconnect ${agentName}? It signs out of ${provider} and will have no model until you connect a subscription or add an API key.`
    : `Disconnect ${agentName}? It goes back to ${backTo} and signs out of ${provider}.`;

const CHATGPT: SubscriptionProviderCopy = {
  modelsUnavailable: 'ChatGPT models are still unavailable. Refresh to try again.',
  modelsLoading: 'Loading ChatGPT models…',
  modelsPending: 'The agent is loading the ChatGPT catalogue after Connect; this takes about a minute.',
  usageShared: 'The limit is shared with your own use of Codex on the same account.',
  usageReached: 'Limit reached: connected agents use their fallback model',
  accountLabel: 'ChatGPT account',
  connectTitle: (agentName) => `Connect ChatGPT to ${agentName}`,
  codeHint: 'Enter this code on OpenAI with your ChatGPT account. It expires in 15 minutes.',
  waiting: 'Waiting for you to finish on OpenAI…',
  disconnectMessage: (agentName, backTo) => `${disconnectMessage(agentName, backTo, 'ChatGPT')} Connecting again needs a new code.`,
};

const CLAUDE: SubscriptionProviderCopy = {
  modelsUnavailable: 'Claude models are still unavailable. Refresh to try again.',
  modelsLoading: 'Loading Claude models…',
  modelsPending: 'The agent is loading the Claude models after Connect; this can take a moment.',
  usageShared: "The limits are your Claude plan's, shared with your own use of Claude.",
  usageReached: 'Limit reached: agents on a Claude model use their fallback model, if they have one',
  accountLabel: 'Claude account',
  connectTitle: (agentName) => `Connect Claude to ${agentName}`,
  codeHint: 'Sign in on Anthropic with your Claude account, then paste here the code Claude Code shows.',
  waiting: 'Waiting for you to finish on Anthropic…',
  disconnectMessage: (agentName, backTo) => `${disconnectMessage(agentName, backTo, 'Claude')} Claude Code stays installed in the agent.`,
  row: {
    notConnected: 'Not connected',
    signedInNotInUse: 'Signed in, not in use',
    needsReconnect: 'Needs a new sign-in',
    connected: 'Connected',
    connectedUntil: (date) => `Connected until ${date}`,
    stopped: 'Stopped',
    error: 'Error',
    connect: 'Connect',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    connecting: 'Connecting…',
    disconnecting: 'Disconnecting…',
  },
  linkCode: {
    starting: 'Starting…',
    installing: 'Installing Claude Code in the agent… This takes about a minute, only the first time.',
    signInStep: 'Sign in on claude.com with your Claude account.',
    openSignIn: "Open Anthropic's sign-in page",
    copyLink: 'Copy link',
    linkCopied: 'Copied',
    copyLinkByHand: 'Copy this link by hand:',
    pasteCodeStep: 'Paste the code Anthropic shows.',
    codeFieldLabel: 'Code from Anthropic',
    continueAction: 'Continue',
    checking: 'Checking…',
    invalidCode: "This doesn't look like a code from Anthropic. Copy it again.",
    verifying: 'Checking the code with Anthropic…',
    connecting: 'Connecting the agent…',
    connected: 'Connected',
    connectedHint: 'Choose a Claude model in the agent panel.',
    done: 'Done',
    startAgain: 'Start again',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    close: 'Close',
    interrupted: 'The login was interrupted. Start again.',
    failed: 'The login did not complete.',
  },
};

export const SUBSCRIPTION_PROVIDER_COPY: Readonly<Record<SubscriptionProviderId, SubscriptionProviderCopy>> = {
  openai: CHATGPT,
  anthropic: CLAUDE,
};

/** The copy for a provider id, or null for anything this build does not know. */
export function getProviderCopy(id: unknown): SubscriptionProviderCopy | null {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PROVIDER_COPY, id)) return null;
  return SUBSCRIPTION_PROVIDER_COPY[id as SubscriptionProviderId];
}

/** The Claude state the server puts on a row (`claude.state`), repeated here to keep this module UI-only. */
export type ClaudeRowState = 'not-installed' | 'signed-out' | 'route-off' | 'connected' | 'needs-reconnect';

/** The fields of one connected-provider row that decide its status line and buttons. */
export interface SubscriptionRowStatus {
  running: boolean;
  connected: boolean;
  error: string | null;
  expiresAt?: string | null;
  claude?: { state: ClaudeRowState; apiAccount?: boolean } | null;
}

/** What one row shows and which actions it offers. */
export interface SubscriptionRowView {
  status: string;
  tone: 'success' | 'neutral' | 'warning' | 'danger';
  /** The primary action: open the connect dialog, or none. */
  action: 'connect' | 'reconnect' | 'none';
  /** Whether Disconnect is offered next to the primary action. */
  disconnect: boolean;
  /** Whether the account email and plan are shown. */
  account: boolean;
}

/**
 * The Claude row, from the server's `claude.state`. The server already narrows the state: the page
 * only turns it into words and buttons. A stopped agent and an unreadable status keep the page's
 * usual wording; an unknown state is treated as "not connected" rather than invented.
 */
export function claudeRowView(
  agent: SubscriptionRowStatus,
  copy: SubscriptionProviderCopy,
  formatDate: (iso: string) => string,
): SubscriptionRowView {
  const row = copy.row;
  if (!row) throw new Error('The Claude row copy is missing from the provider copy map.');
  if (!agent.running) {
    return { status: row.stopped, tone: 'neutral', action: 'connect', disconnect: false, account: false };
  }
  if (agent.error) {
    // An API (Console) account: the error is shown and Disconnect signs it out, so a Claude plan can be connected.
    return { status: row.error, tone: 'danger', action: 'connect', disconnect: agent.claude?.apiAccount === true, account: false };
  }
  switch (agent.claude?.state) {
    case 'connected':
      return {
        status: agent.expiresAt ? row.connectedUntil(formatDate(agent.expiresAt)) : row.connected,
        tone: 'success',
        action: 'none',
        disconnect: true,
        account: true,
      };
    case 'route-off':
      return { status: row.signedInNotInUse, tone: 'warning', action: 'reconnect', disconnect: true, account: true };
    case 'needs-reconnect':
      return { status: row.needsReconnect, tone: 'warning', action: 'reconnect', disconnect: true, account: false };
    case 'not-installed':
    case 'signed-out':
    default:
      return { status: row.notConnected, tone: 'neutral', action: 'connect', disconnect: false, account: false };
  }
}

/** The steps the guided dialog can show, from the login job's state. */
export type LinkCodeStep =
  | 'starting'
  | 'installing'
  | 'waiting'
  | 'verifying'
  | 'connecting'
  | 'connected'
  | 'failed';

/**
 * The dialog step for one login state, or `failed` when the job is gone. `expired` and `cancelled`
 * are final: the dialog offers "Start again" (or has already closed, for a cancel).
 */
export function linkCodeStep(state: string | null): LinkCodeStep {
  switch (state) {
    case 'starting': return 'starting';
    case 'installing': return 'installing';
    case 'waiting': return 'waiting';
    case 'verifying': return 'verifying';
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    default: return 'failed';
  }
}
