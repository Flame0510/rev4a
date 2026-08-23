/**
 * GET /api/wizard/status
 *
 * Returns whether the wizard is complete.
 * Checks a persistent file so it survives browser changes and cache clears.
 */
import { NextResponse, type NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { REV4A_DATA } from '@/lib/rev4a-paths';
import { requireAuthIfConfigured } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

const WIZARD_FILE = path.join(REV4A_DATA, 'data', 'wizard.json');

function readWizardFile(): boolean {
  try {
    const raw = fs.readFileSync(WIZARD_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data.done === true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthIfConfigured(request);
  if (denied) return denied;
  return NextResponse.json({ done: readWizardFile() });
}
