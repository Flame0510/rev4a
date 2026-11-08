/** Base64url HMAC-SHA256 of a fixed session label and password, truncated to 22 characters. */
export function passwordFingerprint(password: string, jwtSecret: string): string;
/** Constant-time comparison of string fingerprints; missing or non-string claims fail closed. */
export function fingerprintEquals(supplied: unknown, expected: unknown): boolean;
