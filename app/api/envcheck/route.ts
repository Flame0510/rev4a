import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { describeEnv } from '@/lib/envcheck';

export async function GET(request: NextRequest) {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  return NextResponse.json(describeEnv(process.env));
}
