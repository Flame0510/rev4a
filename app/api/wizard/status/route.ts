/**
 * GET /api/wizard/status
 *
 * Returns whether the wizard is complete.
 * Used by client components instead of reading the httpOnly cookie directly.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const done = cookieStore.get('wizard_done')?.value === '1';
  return NextResponse.json({ done });
}
