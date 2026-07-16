const WIZARD_STATUS_URL = '/api/wizard/status';

/** Check whether wizard is fully complete (via API, works with httpOnly cookies). */
export async function isWizardComplete(): Promise<boolean> {
  try {
    const res = await fetch(WIZARD_STATUS_URL);
    if (!res.ok) return false;
    const data: { done: boolean } = await res.json();
    return data.done === true;
  } catch {
    return false;
  }
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
