/** Types for the CommonJS client address helper shared by server.js and the login route. */

export const CLIENT_IP_HEADER: 'x-rev4a-client-ip';
export function normaliseIp(value: unknown): string;
export function isPrivateOrLoopback(value: unknown): boolean;
export function clientAddress(remoteAddress: string | undefined | null, xffHeader: string | undefined | null): string;
