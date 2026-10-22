import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';

import { getAgentDisplayNames } from '@/lib/agent-names';
import { listOpenClawCronJobs } from '@/lib/openclaw-cron';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const result = await listOpenClawCronJobs();
  // `agentName` is the agent's display name (AGENT_NAME); null for an agent without one. Additive: `containerName` and `agentId` are unchanged.
  const containers = result.jobs.map((j) => j.containerName).filter((c): c is string => !!c);
  const names = await getAgentDisplayNames([...containers, ...result.errors.map((e) => e.container)]);
  const jobs = result.jobs.map((job) => ({ ...job, agentName: (job.containerName && names.get(job.containerName)) || null }));
  // `?status=1` (the Crons page) answers { jobs, dockerUnavailable, errors } so an empty list can be told apart from
  // "Docker is not reachable" or "an agent did not answer"; without it the answer is the bare array, as always.
  if (new URL(request.url).searchParams.get('status') === '1') {
    return NextResponse.json({
      jobs,
      dockerUnavailable: result.dockerUnavailable,
      errors: result.errors.map((e) => ({ ...e, agentName: names.get(e.container) || null })),
    });
  }
  return NextResponse.json(jobs);
}
