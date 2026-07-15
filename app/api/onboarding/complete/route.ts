/**
 * POST /api/onboarding/complete
 *
 * Body: { step?: string }  — marks a single step as completed
 * Body: {}                 — marks ALL steps as completed
 *
 * Creates/updates data/onboarding-progress.json.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

const FLAG_FILE = path.join(process.cwd(), 'data', 'onboarding-progress.json');
const STEP_KEYS = ['welcome', 'providers', 'agents'];

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const dir = path.dirname(FLAG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing progress or initialize
    let steps: Record<string, boolean> = { welcome: false, providers: false, agents: false };
    if (fs.existsSync(FLAG_FILE)) {
      const raw = fs.readFileSync(FLAG_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.steps) steps = { ...steps, ...data.steps };
    }

    let body: { step?: string; reset?: boolean } = {};
    try { body = await request.json(); } catch { /* empty body = complete all */ }

    if (body.reset) {
      // Reset all steps to false
      fs.writeFileSync(
        FLAG_FILE,
        JSON.stringify({ steps: { welcome: false, providers: false, agents: false }, completedAt: null, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
      return NextResponse.json({ status: 'ok', steps: { welcome: false, providers: false, agents: false }, complete: false });
    }

    if (body.step && STEP_KEYS.includes(body.step)) {
      steps[body.step] = true;
    } else {
      // Complete all steps
      for (const k of STEP_KEYS) steps[k] = true;
    }

    const allComplete = Object.values(steps).every(Boolean);

    fs.writeFileSync(
      FLAG_FILE,
      JSON.stringify({
        steps,
        completedAt: allComplete ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    );

    return NextResponse.json({ status: 'ok', steps, complete: allComplete });
  } catch (e: unknown) {
    console.error('[onboarding/complete]', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
