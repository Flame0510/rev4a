import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';

const SENSITIVE = ['REV4A_PASSWORD', 'REV4A_TOKEN', 'REV4A_JWT_SECRET', 'PROVIDER_DEEPSEEK_API_KEY'];

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  const safe: Record<string, string> = {};
  for (const key of ['REV4A_PASSWORD', 'REV4A_TOKEN', 'REV4A_JWT_SECRET', 'REV4A_ALERTS_ENABLED', 'REV4A_DB', 'REV4A_WORKSPACE_ROOT', 'PROVIDER_DEEPSEEK_API_KEY', 'NODE_ENV']) {
    const val = process.env[key];
    if (SENSITIVE.includes(key)) {
      safe[key] = val ? '✅ set (' + val.substring(0, 4) + '...)' : '❌ not set';
    } else {
      safe[key] = val || '(not set)';
    }
  }
  return NextResponse.json(safe);
}
