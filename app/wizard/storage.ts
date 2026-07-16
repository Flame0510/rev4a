const COOKIE_KEY = 'wizard_done';

export interface WizardState {
  welcome: boolean;
  providers: boolean;
  agents: boolean;
}

/** Read a cookie value by name from document.cookie. */
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Check whether wizard is fully complete (from cookie). */
export function isWizardComplete(): boolean {
  return getCookie(COOKIE_KEY) === '1';
}

/** Mark wizard as done — calls API which sets the cookie server-side. */
export async function markWizardComplete(): Promise<boolean> {
  try {
    const res = await fetch('/api/wizard/complete', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reset wizard — calls API which removes the cookie. */
export async function resetWizard(): Promise<boolean> {
  try {
    const res = await fetch('/api/wizard/reset', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Read detailed step state from localStorage (used by wizard during active session). */
export function readWizardState(): WizardState | null {
  try {
    const raw = localStorage.getItem('olympus_wizard');
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      welcome: data.welcome === true,
      providers: data.providers === true,
      agents: data.agents === true,
    };
  } catch {
    return null;
  }
}

/** Save detailed step state to localStorage (used by wizard during active session). */
export function saveWizardState(state: WizardState): void {
  localStorage.setItem('olympus_wizard', JSON.stringify(state));
}
