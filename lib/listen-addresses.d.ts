/** Types for the CommonJS listen-address rules shared by server.js and the agent port code. */
export interface ListenHost {
  platform?: string;
  /** The Docker default bridge gateway (what host.docker.internal resolves to on Linux), or null. */
  gateway?: string | null;
  hasIpv6?: boolean;
  hostAddresses?: readonly string[];
}
export interface ListenResult {
  mode: 'all' | 'local' | 'address';
  /** The one IP asked for (mode `address`), else null. */
  address: string | null;
  /** Empty for `all`: one wildcard listener. */
  addresses: string[];
  warnings: string[];
  errors: string[];
}
export function listenAddresses(value: string | undefined | null, host?: ListenHost): ListenResult;
export function gatewayFromBridge(network: unknown): string | null;
export function formatHostPort(address: string, port: number | string): string;
export interface AgentPortsListen {
  mode: 'all' | 'local' | 'address';
  /** null: unset, keep each binding as it is (new agents: every interface). '': explicit `all`, every interface, also on recreate. */
  hostIp: string | null;
  warnings: string[];
}
/** With `hostAddresses`, an address the host lacks degrades to `local` with a warning. */
export function agentPortsListen(value: string | undefined | null, hostAddresses?: readonly string[]): AgentPortsListen;
export function docker0Address(interfaces: unknown): string | null;
export function hostAddressList(interfaces: unknown): string[];
export function hostHasAddress(address: string, hostAddresses: readonly string[]): boolean;
export function hostIpsFromPortArgs(portArgs: readonly string[]): string[];
export type ListenSetting =
  | { kind: 'all' | 'local' }
  | { kind: 'address'; address: string }
  | { kind: 'invalid'; text: string };
export function parseSetting(value: string | undefined | null): ListenSetting;
