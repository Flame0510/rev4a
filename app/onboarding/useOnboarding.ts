'use client';

import { useState, useEffect, useCallback } from 'react';

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

const STEP_ORDER: Step[] = ['welcome', 'providers', 'agents', 'done'];

/** Hook: encapsulates all onboarding state + API calls. Single source of truth for the wizard. */
export function useOnboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>({
    deepseek: '', openai: '', openrouter: '', groq: '',
  });

  // Load current progress on mount, jump to first incomplete step
  useEffect(() => {
    fetch('/api/onboarding/status')
      .then((r) => r.json())
      .then((d: OnboardingProgress) => {
        setProgress(d);
        const steps = d.steps;
        if (!steps.welcome) setStep('welcome');
        else if (!steps.providers) setStep('providers');
        else if (!steps.agents) setStep('agents');
        else setStep('done');
      })
      .catch(() => {});
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);

  const markStep = useCallback(async (stepKey: string) => {
    await fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepKey }),
    });
    // Optimistic local update
    setProgress((prev) => prev ? {
      ...prev,
      steps: { ...prev.steps, [stepKey]: true },
      complete: Object.values({ ...prev.steps, [stepKey]: true }).every(Boolean),
    } : null);
  }, []);

  const saveProviders = useCallback(async () => {
    const entries = Object.entries(providerKeys).filter(([, v]) => v.trim());
    if (entries.length === 0) return;
    setSaving(true);
    try {
      for (const [provider, apiKey] of entries) {
        await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
        });
      }
      await markStep('providers');
    } catch { /* non-fatal */ }
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
    // Reset all steps via API (POST without step = complete all, but we want the opposite)
    // Delete the progress file via a reset endpoint or set all to false
    await fetch('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    setProgress({
      complete: false,
      steps: { welcome: false, providers: false, agents: false },
      completedAt: null,
    });
    setStep('welcome');
    setProviderKeys({ deepseek: '', openai: '', openrouter: '', groq: '' });
  }, []);

  return {
    step, stepIndex, saving, progress, providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart,
  };
}
