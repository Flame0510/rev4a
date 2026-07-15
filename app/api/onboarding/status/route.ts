/**
 * GET /api/onboarding/status
 *
 * Returns per-step progress and whether the onboarding is fully complete.
 * Reads data/onboarding-progress.json.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

const FLAG_FILE = path.join(process.cwd(), 'data', 'onboarding-progress.json');

const DEFAULT_STEPS = { welcome: false, providers: false, agents: false };

export async function GET(): Promise<NextResponse> {
  try {
    if (fs.existsSync(FLAG_FILE)) {
      const raw = fs.readFileSync(FLAG_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const steps = { ...DEFAULT_STEPS, ...(data.steps || {}) };
      const complete = Object.values(steps).every(Boolean);
      return NextResponse.json({ complete, steps, completedAt: data.completedAt || null });
    }
    return NextResponse.json({ complete: false, steps: DEFAULT_STEPS, completedAt: null });
  } catch {
    return NextResponse.json({ complete: false, steps: DEFAULT_STEPS, completedAt: null });
  }
}
