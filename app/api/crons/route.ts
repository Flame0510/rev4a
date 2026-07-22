import { NextResponse } from 'next/server';

import { listOpenClawCronJobs } from '@/lib/openclaw-cron';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const result = await listOpenClawCronJobs();
  return NextResponse.json(result.jobs);
}
