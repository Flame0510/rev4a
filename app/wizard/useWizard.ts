'use client';

import { useState, useCallback, useEffect } from 'react';
import { useModels } from '../lib/models-context';
import {
  isWizardComplete,
  markWizardComplete,
  resetWizard,
} from './storage';

export type Step = 'welcome' | 'access' | 'providers' | 'agents' | 'done';

export interface ProviderKeys {
  deepseek: string;
  openai: string;
  openrouter: string;
  groq: string;
}

export const STEP_ORDER: Step[] = ['welcome', 'access', 'providers', 'agents', 'done'];
const PROVIDER_SAVE_ERROR = 'Could not save the API keys. Try again.';

export function useWizard() {
  const [step, setStep] = useState<Step>('welcome');
  const [saving, setSaving] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [complete, setComplete] = useState(false);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>({
    deepseek: '', openai: '', openrouter: '', groq: '',
  });
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from the persistent completion status. If done → show done step.
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
    // Step tracking is in-memory only; completion is persisted through the API.
  }, []);

  // Saving a key changes which models are offered; the shared list must follow.
  const { refresh: refreshOfferedModels } = useModels();

  const saveProviders = useCallback(async (): Promise<boolean> => {
    setProviderError('');
    const entries = Object.entries(providerKeys).filter(([, v]) => v.trim());
    if (entries.length === 0) {
      markStep('providers');
      return true;
    }
    setSaving(true);
    try {
      for (const [provider, apiKey] of entries) {
        const res = await fetch('/api/gateway/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setProviderError(typeof body?.error === 'string' && body.error ? body.error : PROVIDER_SAVE_ERROR);
          return false;
        }
      }
      refreshOfferedModels();
      markStep('providers');
      return true;
    } catch {
      setProviderError(PROVIDER_SAVE_ERROR);
      return false;
    } finally {
      setSaving(false);
    }
  }, [providerKeys, markStep, refreshOfferedModels]);

  const goNext = useCallback(async () => {
    if (step === 'welcome') { markStep('welcome'); setStep('access'); }
    else if (step === 'access') { markStep('access'); setStep('providers'); }
    else if (step === 'providers') { if (await saveProviders()) setStep('agents'); }
    else if (step === 'agents') { markStep('agents'); setStep('done'); }
  }, [step, saveProviders, markStep]);

  const skip = useCallback(() => {
    if (step === 'welcome') { markStep('welcome'); setStep('access'); }
    else if (step === 'access') { markStep('access'); setStep('providers'); }
    else if (step === 'providers') { setProviderError(''); markStep('providers'); setStep('agents'); }
    else if (step === 'agents') { markStep('agents'); setStep('done'); }
  }, [step, markStep]);

  const goToStep = useCallback((index: number) => {
    const key = STEP_ORDER[index];
    if (key) setStep(key);
  }, []);

  const completeAll = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const done = await markWizardComplete(signal);
    if (signal?.aborted) return false;
    if (done) setComplete(true);
    return done;
  }, []);

  const restart = useCallback(async () => {
    setComplete(false);
    await resetWizard();
    setStep('welcome');
    setProviderError('');
    setProviderKeys({ deepseek: '', openai: '', openrouter: '', groq: '' });
  }, []);

  return {
    step, stepIndex, saving, complete, providerKeys, providerError,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart, hydrated,
  };
}
