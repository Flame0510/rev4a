/**
 * GET /api/wizard/status
 *
 * Returns whether the wizard is complete.
 * Checks a persistent file so it survives browser changes and cache clears.
 */
import { NextResponse } from 'next/server';
import * as fs from 'fs';
import { OLYMPUS_DATA } from '@/lib/olympus-paths';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = OLYMPUS_DATA + '/data/wizard.json';

function readWizardFile(): boolean {
  try {
    const raw = fs.readFileSync(WIZARD_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data.done === true;
  } catch {
    return false;
  }
}

export function GET(): NextResponse {
  const done = readWizardFile();
  return NextResponse.json({ done });
}
