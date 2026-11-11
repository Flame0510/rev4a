const WIZARD_STATUS_URL = '/api/wizard/status';
const SETUP_CODE_KEY = 'rev4a.wizard.setupCode';

/** Only wizard/setup requests carry this per-tab code; storage may be unavailable. */
export function rememberSetupCode(code: string): void {
  try { sessionStorage.setItem(SETUP_CODE_KEY, code); } catch { /* storage disabled */ }
}

export function setupCodeHeaders(): Record<string, string> {
  try {
    const code = sessionStorage.getItem(SETUP_CODE_KEY);
    return code ? { 'x-rev4a-setup-code': code } : {};
  } catch { return {}; }
}

/** Check whether wizard is fully complete (via API, works with httpOnly cookies). */
export async function isWizardComplete(): Promise<boolean> {
  try {
    const res = await fetch(WIZARD_STATUS_URL, { headers: setupCodeHeaders() });
    if (!res.ok) return false;
    const data: { done: boolean } = await res.json();
    return data.done === true;
  } catch {
    return false;
  }
}

/** Persist completion and set the legacy wizard_done cookie (not the login session). */
export async function markWizardComplete(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/wizard/complete', { method: 'POST', headers: setupCodeHeaders(), signal });
    if (res.ok) {
      try { sessionStorage.removeItem(SETUP_CODE_KEY); } catch { /* storage disabled */ }
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** Reset wizard — calls API which removes the cookie. */
export async function resetWizard(): Promise<boolean> {
  try {
    const res = await fetch('/api/wizard/reset', { method: 'POST', headers: setupCodeHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}
