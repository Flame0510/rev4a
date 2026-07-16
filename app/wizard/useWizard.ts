'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  readWizardState,
  type WizardState,
  saveWizardState,
  isWizardComplete,
  markWizardComplete,
  resetWizard,
} from './storage';

export type Step = 'welcome' | 'providers' | 'agents' | 'done';

export interface ProviderKeys {
  deepseek: string;
  openai: string;
  openrouter: string;
  groq: string;
}

const STEP_ORDER: Step[] = ['welcome', 'providers', 'agents', 'done'];

function computeInitialStep(state: WizardState): Step {
  if (!state.welcome) return 'welcome';
  if (!state.providers) return 'providers';
  if (!state.agents) return 'agents';
  return 'done';
}

export function useWizard() {
  const [state, setState] = useState<WizardState>({ welcome: false, providers: false, agents: false });
  const [step, setStep] = useState<Step>('welcome');
  const [saving, setSaving] = useState(false);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>({
    deepseek: '', openai: '', openrouter: '', groq: '',
  });
  const [hydrated, setHydrated] = useState(false);

  // Hydrate on mount:
  // - If cookie wizard_done=1 → DoneStep (user already completed)
  // - Else read localStorage for in-progress state → resume from that step
  // - If nothing in localStorage → welcome (fresh start)
  useEffect(() => {
    if (isWizardComplete()) {
      setStep('done');
      setState({ welcome: true, providers: true, agents: true });
    } else {
      const loaded = readWizardState() || { welcome: false, providers: false, agents: false };
      setState(loaded);
      setStep(computeInitialStep(loaded));
    }
    setHydrated(true);
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);

  const markStep = useCallback((stepKey: keyof WizardState) => {
    setState((prev) => {
      const next = { ...prev, [stepKey]: true };
      saveWizardState(next);
      window.dispatchEvent(new CustomEvent('wizard-step-changed', {
        detail: { steps: next, complete: next.welcome && next.providers && next.agents },
      }));
      return next;
    });
  }, []);

  const saveProviders = useCallback(async () => {
    const entries = Object.entries(providerKeys).filter(([, v]) => v.trim());
    if (entries.length === 0) {
      markStep('providers');
      return;
    }
    setSaving(true);
    try {
      let allSaved = true;
      for (const [provider, apiKey] of entries) {
        const res = await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
        });
        if (!res.ok) allSaved = false;
      }
      if (allSaved) markStep('providers');
    } catch { /* API call failed — do not mark step as complete */ }
    setSaving(false);
  }, [providerKeys, markStep]);

  const goNext = useCallback(async () => {
    if (step === 'welcome') { markStep('welcome'); setStep('providers'); }
    else if (step === 'providers') { await saveProviders(); setStep('agents'); }
    else if (step === 'agents') { markStep('agents'); setStep('done'); }
  }, [step, saveProviders, markStep]);

  const skip = useCallback(() => {
    if (step === 'welcome') { markStep('welcome'); setStep('providers'); }
    else if (step === 'providers') { markStep('providers'); setStep('agents'); }
    else if (step === 'agents') { markStep('agents'); setStep('done'); }
  }, [step, markStep]);

  const goToStep = useCallback((index: number) => {
    const key = STEP_ORDER[index];
    if (key) setStep(key);
  }, []);

  const completeAll = useCallback(async () => {
    const allDone: WizardState = { welcome: true, providers: true, agents: true };
    setState(allDone);
    saveWizardState(allDone);
    await markWizardComplete(); // set cookie — blocks re-wizard across devices
    window.dispatchEvent(new CustomEvent('wizard-step-changed', {
      detail: { steps: allDone, complete: true },
    }));
  }, []);

  const restart = useCallback(async () => {
    const fresh: WizardState = { welcome: false, providers: false, agents: false };
    setState(fresh);
    saveWizardState(fresh);
    await resetWizard(); // clear cookie
    setStep('welcome');
    setProviderKeys({ deepseek: '', openai: '', openrouter: '', groq: '' });
    window.dispatchEvent(new CustomEvent('wizard-step-changed', {
      detail: { steps: fresh, complete: false },
    }));
  }, []);

  return {
    step, stepIndex, saving, complete: isWizardComplete(), providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart, hydrated,
  };
}
