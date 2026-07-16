'use client';

import { useState, useCallback, useEffect } from 'react';
import {
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

export function useWizard() {
  const [step, setStep] = useState<Step>('welcome');
  const [saving, setSaving] = useState(false);
  const [complete, setComplete] = useState(false);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>({
    deepseek: '', openai: '', openrouter: '', groq: '',
  });
  const [hydrated, setHydrated] = useState(false);

  // Hydrate: check cookie only. If done → show done step.
  // If not done → always start from welcome (no localStorage resume).
  useEffect(() => {
    const hydrate = async () => {
      const done = await isWizardComplete();
      setComplete(done);
      if (done) setStep('done');
      setHydrated(true);
    };
    hydrate();
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);

  const markStep = useCallback((_stepKey: string) => {
    // Step tracking is in-memory only; the cookie is the source of truth
  }, []);

  const saveProviders = useCallback(async () => {
    const entries = Object.entries(providerKeys).filter(([, v]) => v.trim());
    if (entries.length === 0) {
      markStep('providers');
      return;
    }
    setSaving(true);
    try {
      for (const [provider, apiKey] of entries) {
        await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
        });
      }
      markStep('providers');
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
    setComplete(true);
    await markWizardComplete();
  }, []);

  const restart = useCallback(async () => {
    setComplete(false);
    await resetWizard();
    setStep('welcome');
    setProviderKeys({ deepseek: '', openai: '', openrouter: '', groq: '' });
  }, []);

  return {
    step, stepIndex, saving, complete, providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart, hydrated,
  };
}
