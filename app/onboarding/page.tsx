import { requireAuth } from '@/lib/requireAuth';
import OnboardingPageClient from './PageClient';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

interface InitialProgress {
  complete: boolean;
  steps: { welcome: boolean; providers: boolean; agents: boolean };
  completedAt: string | null;
  initialStep: string;
}

export default async function OnboardingPage() {
  await requireAuth();

  let initialProgress: InitialProgress = {
    complete: false,
    steps: { welcome: false, providers: false, agents: false },
    completedAt: null,
    initialStep: 'welcome',
  };

  try {
    const flagFile = path.join(process.cwd(), 'data', 'onboarding-progress.json');
    if (fs.existsSync(flagFile)) {
      const raw = fs.readFileSync(flagFile, 'utf-8');
      const data = JSON.parse(raw);
      const steps = { welcome: false, providers: false, agents: false, ...(data.steps || {}) };
      const complete = Object.values(steps).every(Boolean);
      let initialStep = 'welcome';
      if (!steps.welcome) initialStep = 'welcome';
      else if (!steps.providers) initialStep = 'providers';
      else if (!steps.agents) initialStep = 'agents';
      else initialStep = 'done';

      initialProgress = {
        complete,
        steps,
        completedAt: data.completedAt || null,
        initialStep,
      };
    }
  } catch { /* fallback to defaults */ }

  return <OnboardingPageClient initial={initialProgress} />;
}
