export const SUBSCRIPTION_PREFIX: string;

export interface DeviceLogin {
  url: string | null;
  code: string | null;
  expiresInMin: number | null;
  done: 'ok' | 'failed' | null;
  error: string | null;
}

export interface AuthProfile {
  id: string;
  type: string | null;
  email: string | null;
  expiresAt: string | null;
  plan?: string | null;
}

export interface SubscriptionModel {
  key: string;
  name: string;
  contextWindow: number | null;
}

export type AgentModelRef = string | { primary?: string | null; fallbacks?: string[] } | null | undefined;

export interface ModelPair {
  primary: string | null;
  fallbacks: string[];
}

export function cleanTerminalText(text: string): string;
export function parseDeviceLogin(text: string): DeviceLogin;
export function parseAuthList(input: unknown): AuthProfile[] | null;
export interface StatusProfile {
  id: string;
  type: string | null;
  provider: string | null;
  email: string | null;
  expiresAt: string | null;
  plan: string | null;
}

export interface StatusRead {
  /** The agent has another layout (no node:sqlite, no table): use the CLI. */
  legacy: boolean;
  profiles: StatusProfile[];
  model: ModelPair | null;
  error: string | null;
}

export function formatPlan(plan: unknown): string | null;
export function parseStatusJson(input: unknown): StatusRead | null;
export function parseModelList(input: unknown): SubscriptionModel[] | null;
export function isSubscriptionModel(id: unknown): boolean;
export function normalizeModel(model: AgentModelRef): ModelPair;
export function stopSubscriptionModel(model: AgentModelRef): AgentModelRef;
export function mapStoreProfile(id: string, x: unknown): StatusProfile;

/** Source text of mapStoreProfile, embedded in the in-container status script. */
export const MAP_STORE_PROFILE_SRC: string;
/** The in-container status read script (fixed text). */
export const STATUS_SCRIPT_SRC: string;

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** ISO time the window resets; null when unknown. */
  resetAt: string | null;
}

export interface UsageAccount {
  email: string | null;
  plan: string | null;
  windows: UsageWindow[];
  updatedAt: string | null;
}

export function parseUsageStatus(text: unknown): { accounts: UsageAccount[] };
