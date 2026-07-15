'use client';

import { useState, useCallback } from 'react';

export type Step = 'welcome' | 'providers' | 'agents' | 'done';

export interface ProviderKeys {
  deepseek: string;
  openai: string;
  openrouter: string;
  groq: string;
}

export interface OnboardingProgress {
  complete: boolean;
  steps: { welcome: boolean; providers: boolean; agents: boolean };
  completedAt: string | null;
}

export interface OnboardingInitial {
  complete: boolean;
  steps: { welcome: boolean; providers: boolean; agents: boolean };
  completedAt: string | null;
  initialStep: string;
}

const STEP_ORDER: Step[] = ['welcome', 'providers', 'agents', 'done'];

/** Hook: encapsulates all onboarding state + API calls. Receives initial state from server to avoid loading flash. */
export function useOnboarding(initial: OnboardingInitial) {
  const [step, setStep] = useState<Step>(initial.initialStep as Step);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<OnboardingProgress>({
    complete: initial.complete,
    steps: initial.steps,
    completedAt: initial.completedAt,
  });
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>({
    deepseek: '', openai: '', openrouter: '', groq: '',
  });

  const stepIndex = STEP_ORDER.indexOf(step);

  const markStep = useCallback(async (stepKey: string) => {
    const res = await fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepKey }),
    });
    if (!res.ok) return;

    const updatedSteps = { ...progress.steps, [stepKey]: true };
    const allComplete = Object.values(updatedSteps).every(Boolean);
    setProgress((prev) => ({ ...prev, steps: updatedSteps, complete: allComplete }));

    window.dispatchEvent(new CustomEvent('onboarding-step-changed', {
      detail: { steps: updatedSteps, complete: allComplete },
    }));
  }, [progress]);

  const saveProviders = useCallback(async () => {
    const entries = Object.entries(providerKeys).filter(([, v]) => v.trim());
    if (entries.length === 0) {
      await markStep('providers');
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
      if (allSaved) {
        await markStep('providers');
      }
    } catch { /* API call failed — do not mark step as complete */ }
    setSaving(false);
  }, [providerKeys, markStep]);

  const goNext = useCallback(async () => {
    if (step === 'welcome') { await markStep('welcome'); setStep('providers'); }
    else if (step === 'providers') { await saveProviders(); setStep('agents'); }
    else if (step === 'agents') { await markStep('agents'); setStep('done'); }
  }, [step, saveProviders, markStep]);

  const skip = useCallback(async () => {
    if (step === 'welcome') { await markStep('welcome'); setStep('providers'); }
    else if (step === 'providers') { await markStep('providers'); setStep('agents'); }
    else if (step === 'agents') { await markStep('agents'); setStep('done'); }
  }, [step, markStep]);

  const goToStep = useCallback((index: number) => {
    const key = STEP_ORDER[index];
    if (key) setStep(key);
  }, []);

  const completeAll = useCallback(async () => {
    setSaving(true);
    await fetch('/api/onboarding/complete', { method: 'POST', body: '{}' });
    setSaving(false);
  }, []);

  const restart = useCallback(async () => {
    await fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    setProgress({ complete: false, steps: { welcome: false, providers: false, agents: false }, completedAt: null });
    setStep('welcome');
    setProviderKeys({ deepseek: '', openai: '', openrouter: '', groq: '' });
    window.dispatchEvent(new CustomEvent('onboarding-step-changed', {
      detail: { steps: { welcome: false, providers: false, agents: false }, complete: false },
    }));
  }, []);

  return {
    step, stepIndex, saving, progress, providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart,
  };
}
