import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';

import { listOpenClawCronJobs } from '@/lib/openclaw-cron';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await listOpenClawCronJobs();
  return NextResponse.json(result.jobs);
}
