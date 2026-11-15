const CHECK_FAILED = 'Could not verify your session. Check your connection and try again.';

/** Only a 401 confirms that the browser has no usable session cookie. */
export function sessionCookieMessage(status: number, protocol: string): string | null {
  if (status >= 200 && status < 300) return null;
  if (status !== 401) return CHECK_FAILED;
  return protocol === 'http:'
    ? 'Signed in, but your browser refused the session cookie. Check that cookies are allowed for this site, or serve Rev4a over HTTPS.'
    : 'Signed in, but your browser did not keep the session cookie. Check that cookies are allowed for this site.';
}

/** Verify cookie round-trip before navigating; never infer transport from proxy headers. */
export async function checkSessionCookie(protocol: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/check', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    });
    return sessionCookieMessage(response.status, protocol);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error;
    return CHECK_FAILED;
  }
}
