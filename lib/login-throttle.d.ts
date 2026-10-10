/** Types for the CommonJS login throttle used by app/api/auth/login/route.ts. */

export interface LoginThrottleOptions {
  /** Clock in epoch milliseconds. Default: Date.now. */
  now?: () => number;
  /** Failures inside the window that cost nothing. Default: 5. */
  freeFailures?: number;
  /** Window after which a failure is forgotten, in ms. Default: 15 minutes. */
  windowMs?: number;
  /** Lock after the first failure past the free ones, in ms. Doubles with each failure. Default: 30 s. */
  baseLockMs?: number;
  /** Longest lock, in ms. Default: 15 minutes. */
  maxLockMs?: number;
  /** Most keys kept; the least recently active is evicted. Default: 10 000. */
  maxKeys?: number;
}

export type LoginThrottleCheck =
  | { allowed: true }
  | { allowed: false; retryAfterS: number };

export interface LoginThrottle {
  check(key: string): LoginThrottleCheck;
  fail(key: string): void;
  succeed(key: string): void;
  size(): number;
}

export const DEFAULTS: Required<Omit<LoginThrottleOptions, 'now'>>;
export function createLoginThrottle(options?: LoginThrottleOptions): LoginThrottle;
