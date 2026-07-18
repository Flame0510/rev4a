import { NextResponse } from 'next/server';
import { abortBuild } from '@/lib/buildAgentImage';

export async function POST() {
  const aborted = abortBuild();
  return NextResponse.json({ aborted });
}
